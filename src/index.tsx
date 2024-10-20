import { Context, Fragment, h, Session, z } from 'koishi'
import * as cheerio from 'cheerio'
import type {} from 'koishi-plugin-puppeteer'
import type { Page } from 'puppeteer-core'

export const name = 'steaminfo'

export const inject = {
  optional: ['puppeteer'],
}

export interface Config {
  mode: 'text' | 'image' | 'screenshot'
  suggest: {
    fuzzy: boolean
    params: Record<string, string>
  }
  middleware: {
    enable: boolean
  }
  render: {
    imageType: 'webp' | 'png'
  }
}

export const Config: z<Config> = z.object({
  mode: z.union([
    z.const('text').description('纯文本模式'),
    z.const('image').description('带图模式'),
    z.const('screenshot').description('截图模式 (无 puppeteer 无效)'),
  ]).role('radio').default('screenshot'),
  suggest: z.object({
    fuzzy: z.boolean().default(true).description('模糊匹配到游戏名自动发送详情'),
    // https://store.steampowered.com/search/suggest?f=games&cc=CN&realm=1&l=schinese&use_store_query=1&use_search_spellcheck=1&search_creators_and_tags=1&term=
    params: z.dict(String).role('table').default({
      f: 'games',
      cc: 'US',
      realm: '1',
      l: 'schinese',
      use_store_query: '1',
      use_search_spellcheck: '1',
      search_creators_and_tags: '1',
    }).description('搜索请求参数'),
  }),
  middleware: z.object({
    enable: z.boolean().default(true).description('启用中间件检测 Steam 商店链接'),
  }),
  render: z.object({
    imageType: z.union([
      z.const('webp'),
      z.const('png'),
    ]).role('radio').default('png').description('截图格式'),
  }),
})

export async function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('steaminfo')
  ctx.i18n.define('zh-CN', require('./locales/zh-CN'))

  let renderDetail = (session: Session, appid: string, mode?: typeof config.mode) => {
    return renderText(session, appid)
  }

  const renderText = async (session: Session, appid: string): Promise<Fragment> => {
    const { cc, l } = config.suggest.params
    const resp = await ctx.http.get(
      `https://store.steampowered.com/api/appdetails?` + new URLSearchParams({
        cc,
        l,
        appids: appid,
      }).toString(), { responseType: 'json' })
    if (!resp[appid].success) {
      logger.warn('failed to fetch app details')
      return session.text('.not-found')
    }
    const data = resp[appid].data
    let price: string
    if (data.is_free) {
      price = session.text('.free')
    } else {
      price = data.price_overview.final_formatted
      if (data.price_overview.initial_formatted) {
        price = price + ' / ' + data.price_overview.initial_formatted
      }
    }
    const date = session.text('.release-date', data.release_date)
    const developers = session.text('.developers', [data.developers.join(', ')])
    const publishers = session.text('.publishers', [data.publishers.join(', ')])

    const reviewData = await ctx.http.get(`https://store.steampowered.com/appreviews/${appid}?` + new URLSearchParams({
      l,
      json: '1',
      language: 'all',
      num_per_page: '0',
      purchase_type: data.is_free ? 'all' : 'steam',
    }).toString(), { responseType: 'json' })
    let review: string
    if (reviewData.success) {
      const { total_positive, total_reviews } = reviewData.query_summary
      review = session.text('.review', { ...reviewData.query_summary, rate: (total_positive / total_reviews * 100).toFixed(1) })
    }

    const result: h = <>
      <img src={data.header_image}/>
      <p>{data.name}</p>
      <p>{price} {review}</p>
      <p>{date}</p>
      <p>{developers} {publishers}</p>
      <p>{data.short_description}</p>
    </>
    if (config.mode !== 'text') return result
    return h.transform([result], {
      'img': () => '',
    })
  }

  ctx.inject(['puppeteer'], (ctx) => {
    if (config.mode !== 'screenshot') return

    let page: Page
    ctx.on('ready', async () => {
      page = await ctx.puppeteer.page()
    })
    ctx.on('dispose', () => {
      page.close()
    })

    const renderImage = async (session: Session, appid: string) => {
      // TODO 使用中锁定 page

      await page.setCookie(...Object.entries({
        birthtime: '946656001',
        lastagecheckage: '1-January-2000',
        bGameHighlightAutoplayDisabled: 'true',
        wants_mature_content: '1',
      }).map(([k, v]) => {
        return { name: k, value: v, domain: 'store.steampowered.com' }
      }))

      // TODO 检测锁区 / 游戏不存在
      // 未登录情况下 Steam 通过 ip 检测地区
      await page.goto(`https://store.steampowered.com/app/${appid}`, { waitUntil: 'networkidle0' })

      if (await page.$('select#ageYear')) {
        // bypass age gate
        await page.select('select#ageYear', '2000')
        await page.evaluate('ViewProductPage()')
        await page.waitForNetworkIdle()
      }

      const element = await page.waitForSelector('.glance_ctn', { timeout: 5000 })
      const buffer = await element.screenshot({ type: config.render.imageType })

      // TODO 显示价格

      await page.goto('about:blank')
      return h.image(buffer, 'image/' + config.render.imageType)
    }

    renderDetail = (session: Session, appid: string, mode?: Config['mode']) => {
      if (!mode) mode = config.mode
      if (mode === 'text') {
        return renderText(session, appid)
      }
      return renderImage(session, appid)
    }
  })

  ctx.command('steaminfo <name:text>')
    .option('fuzzy', '--fuzzy', { fallback: config.suggest.fuzzy })
    .option('mode', '-m <mode:string>')
    .option('mode', '--text', { value: 'text' })
    .option('mode', '--image', { value: 'image' })
    .action(async ({ session, options }, input) => {
      const params = new URLSearchParams(config.suggest.params)
      params.append('term', input.trim())
      const resp = await ctx.http.get('https://store.steampowered.com/search/suggest?' + params.toString())

      const $ = cheerio.load(resp)
      const result = $.extract({
        names: ['a[data-ds-appid] > .match_name'],
        appids: [{ selector: 'a', value: 'data-ds-appid' }],
      }) as { names: string[]; appids: string[] }

      const length = result.names.length
      if (length < 1) return session.text('.not-found')

      const searchUrl = 'https://store.steampowered.com/search/?' + new URLSearchParams({ term: input.trim(), ndl: '1' }).toString()
      const list = result.names.map((name, i) => `${i + 1}. ${name} - https://store.steampowered.com/app/${result.appids[i]}`).join('\n')
      const answer = <>
        <p>{searchUrl}</p>
        <p>{session.text('.found')}</p>
        <p>{list}</p>
        <p>{result.appids.length > 1 ? session.text('.prompt') : ''}</p>
      </>
      await session.sendQueued(answer)

      if (options.fuzzy) {
        let detail: Fragment
        const fuzzyMatch = result.names[0].toLowerCase().includes(input.toLowerCase())
        if (length === 1 || fuzzyMatch) {
          detail = await renderDetail(session, result.appids[0], options.mode)
        }
        await session.sendQueued(detail)
        if (length === 1) return
      }

      const choice = await session.prompt((session) => {
        const input = h.select(session.elements, 'text')[0]?.toString()
        const index = parseInt(input)
        if (index <= 0 || index > length) {
          return // not to stuck middleware
        }
        return index
      })
      if (!choice) return
      return renderDetail(session, result.appids[choice - 1], options.mode)
    })

  if (config.middleware.enable) {
    const storeUrlRegex = /^(?:https?:\/\/)?store\.steampowered\.com\/app\/(\d+)/
    ctx.middleware(async (session, next) => {
      const contents = session.elements.filter(e => e.type === 'text').map(e => e.attrs.content)
      if (contents.length !== 1) return next()

      const match = storeUrlRegex.exec(contents[0])
      if (!match) return next()

      session.scope = 'commands.steaminfo.messages' // hacky workaround
      return renderDetail(session, match[1])
    })
  }
}
