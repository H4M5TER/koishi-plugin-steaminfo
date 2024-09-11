import { Context, h, Session, z } from 'koishi'
import type {} from 'koishi-plugin-cheerio'
import type {} from 'koishi-plugin-puppeteer'

export const name = 'steaminfo'

export const inject = {
  required: ['cheerio'],
  optional: ['puppeteer'],
}

export interface Config {
  mode: 'text' | 'image'
  suggest: {
    params: [string, string][]
  }
}

export const Config/*: z<Config> */ = z.object({
  mode: z.union([
    z.const('text').description('纯文本模式'),
    z.const('image').description('有图片模式'),
  ]).role('radio').default('image'),
  suggest: z.object({
    params: z.array(z.tuple([z.string(), z.string()] as const)).role('table').default([
      ['f', 'games'],
      ['cc', 'CN'],
      ['realm', '1'],
      ['l', 'schinese'],
      // ['v', ''], // 会变的类似时间戳的东西 没看出有什么用
      // ['excluded_content_descriptors[]', '3'], // 未知
      // ['excluded_content_descriptors[]', '4'],
      ['use_store_query', '1'],
      ['use_search_spellcheck', '1'],
      ['search_creators_and_tags', '1'],
    ]),
  }),
})

export async function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('steaminfo')
  ctx.i18n.define('zh-CN', require('./locales/zh-CN'))

  let renderDetail = async (session: Session, appid: string) => {
    const resp = await ctx.http.get(`https://store.steampowered.com/api/appdetails?appids=${appid}`, { responseType: 'json' })
    if (!resp[appid].success) return ''
    const data = resp[appid].data

    return <>
      <p>{data.name}</p>
      <p>{data.short_description}</p>
      <p>{session.text('.price', { price: data.price_overview.final / 100 })}</p>
    </>
  }

  let page: Awaited<ReturnType<typeof ctx.puppeteer.page>>
  ctx.inject(['puppeteer'], (ctx) => {
    if (config.mode === 'text') return

    ctx.on('ready', async () => {
      page = await ctx.puppeteer.page()
    })
    ctx.on('dispose', () => {
      page.close()
    })

    renderDetail = async (session: Session, appid: string) => {
      await page.setCookie(...Object.entries({
        birthtime: '946656001',
        lastagecheckage: '1-January-2000',
        bGameHighlightAutoplayDisabled: 'true',
        wants_mature_content: '1',
      }).map(([k, v]) => {
        return { name: k, value: v, domain: 'store.steampowered.com' }
      }))

      await page.goto(`https://store.steampowered.com/app/${appid}`, { waitUntil: 'domcontentloaded' })

      if (await page.$('select#ageYear')) {
        // bypass age gate
        await page.select('select#ageYear', '2000')
        page.evaluate('ViewProductPage()')
      }

      const element = await page.waitForSelector('.glance_ctn')
      const buffer = await element.screenshot({ type: 'webp' })
      
      await page.goto('about:blank')
      return h.image(buffer, 'image/webp')
    }
  })

  ctx.command('steaminfo <name:text>')
    .action(async ({ session }, input) => {
      const params = new URLSearchParams(config.suggest.params)
      params.append('term', input.trim())
      const resp = await ctx.http.get('https://store.steampowered.com/search/suggest?' + params.toString())

      const $ = ctx.cheerio.load(resp)
      const result = $.extract({
        names: ['a[data-ds-appid] > .match_name'],
        appids: [{ selector: 'a', value: 'data-ds-appid' }], 
      }) as { names: string[]; appids: string[] }

      const length = result.names.length
      if (length < 1) return session.text('.not-found')

      let detail: h | string = ''
      const exactMatch = result.names[0].toLowerCase().includes(input.toLowerCase())
      if (length === 1 || exactMatch) {
        detail = await renderDetail(session, result.appids[0])
      }

      const answer = <>
        <p>{session.text('.found')}</p>
        <p>{result.names.map((name, i) => `${i + 1}. ${name} - https://store.steampowered.com/app/${result.appids[i]}`).join('\n')}</p>
        <p>{detail}</p>
        <p>{result.appids.length > 1 ? session.text('.prompt') : ''}</p>
      </>
      if (length === 1) return answer
      else session.send(answer)

      const choice = await session.prompt()
      const index = parseInt(choice) - 1
      if (index >= 0 && index < length) {
        return renderDetail(session, result.appids[index])
      }
    })
}
