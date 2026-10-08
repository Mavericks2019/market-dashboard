// These are LIST quote fields (ulist.np/get), not stock/get fields.
// Eastmoney's own quote-center scripts map f115=PE TTM, f23=PB,
// f130=PS TTM and f133=dividend yield. Never reuse these IDs on stock/get.
// Verified in https://quote.eastmoney.com/newstatic/build/vendor.js and
// https://quote.eastmoney.com/center/static/build/index.js (trading time=f124).
// f20 is total capitalization, f21 is free-float capitalization. FTSE members
// are quoted in GBp: uk2.js explicitly says 100 pence = 1 GBP. stock/get's
// f600 confirms the currency, but f600/f601 have OTHER meanings on ulist.
import { fetchCnyQuote } from './cny-market.mjs'

const QUOTES = 'https://push2.eastmoney.com/api/qt/ulist.np/get'
const REPORTS = 'https://datacenter.eastmoney.com/securities/api/data/v1/get'
const TTL = 60_000
const RETRY = 60_000
const SYMBOL_TTL = 24 * 60 * 60_000

function number(value) {
  if (!['number', 'string'].includes(typeof value) || (typeof value === 'string' && !value.trim())) return null
  const result = Number(value)
  return Number.isFinite(result) ? result : null
}

function emptyRow(company, note = '数据源暂未提供此上市证券的估值；缺失不代表零。') {
  return {
    key: company.key, symbol: company.symbol, name: company.name,
    englishName: company.englishName || '', pe: null, pb: null, ps: null,
    dividendYield: null, marketCap: null, marketCapCurrency: null, marketCapSortValue: null,
    marketCapNote: '', marketTime: null, reportDate: null, valuationDate: null,
    sourceName: '东方财富行情', sourceUrl: 'https://quote.eastmoney.com/center/',
    peBasis: 'TTM（近12个月）', pbBasis: '来源市净率', psBasis: 'TTM（近12个月）',
    dividendBasis: '来源股息率（统计期未注明）', note, isStale: false,
  }
}

export function quoteSecid(company, main) {
  if (company.market === 'HK' && /^\d{5}$/.test(company.symbol.replace(/\.HK$/, ''))) {
    return `116.${company.symbol.replace(/\.HK$/, '')}`
  }
  if (company.market === 'CN') {
    const code = company.symbol.split('.')[0]
    if (!/^\d{6}$/.test(code)) return null
    // Exchange comes from the official membership file. Prefix is only a
    // fallback for unambiguous Shanghai/Shenzhen stock codes, never an ADR.
    const exchange = company.secucode?.split('.')[1]
    if (exchange === 'SH' || (!exchange && /^[69]/.test(code))) return `1.${code}`
    if (exchange === 'SZ' || (!exchange && /^[023]/.test(code))) return `0.${code}`
    return null
  }
  const internationalMarket = { JP: 176, KR: 177, GB: 155, DE: 185 }[company.market]
  // London dots are meaningful (RR. and BT.A). Keep local ticker identity;
  // do not substitute an American depositary receipt or an ISIN.
  if (internationalMarket && /^[A-Z0-9][A-Z0-9.-]{0,11}$/.test(company.symbol)
    && !/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(company.symbol)) return `${internationalMarket}.${company.symbol}`
  if (company.market !== 'US' || !main) return null
  const code = company.symbol.replaceAll('.', '_')
  if (main.SECURITY_CODE !== code) return null
  const [sourceCode, exchange] = main.SECUCODE?.split('.') || []
  const market = { O: 105, N: 106, A: 107 }[exchange]
  return market && sourceCode === code ? `${market}.${sourceCode}` : null
}

export function makeConstituentValuation(company, quote, secid, now = Date.now(), usdCny = null) {
  if (!quote || `${quote.f13}.${quote.f12}` !== secid) throw new Error('估值返回了不同的上市证券')
  const row = emptyRow(company)
  row.pe = number(quote.f115)
  row.pb = number(quote.f23)
  row.ps = number(quote.f130)
  row.dividendYield = number(quote.f133)
  const cap = number(quote.f20)
  const code = company.symbol.split('.')[0]
  const isShanghaiB = company.market === 'CN' && /^900\d{3}$/.test(code)
  const isShenzhenB = company.market === 'CN' && /^200\d{3}$/.test(code)
  row.marketCapCurrency = isShanghaiB ? 'USD' : isShenzhenB ? 'HKD'
    : { US: 'USD', CN: 'CNY', HK: 'HKD', GB: 'GBP', DE: 'EUR', JP: 'JPY', KR: 'KRW' }[company.market] || null
  row.marketCap = cap !== null && cap > 0 ? cap / (company.market === 'GB' ? 100 : 1) : null
  row.marketCapSortValue = row.marketCap
  row.marketCapNote = '总市值按该上市证券的来源报价口径，非流通市值。'
  if (company.market === 'GB') row.marketCapNote += '来源以英镑便士计值，已除以100换为英镑。'
  if (isShanghaiB || isShenzhenB) {
    row.marketCapSortValue = null
    if (isShanghaiB && row.marketCap !== null && number(usdCny?.price) > 0
      && number(usdCny?.marketTime) > 946684800 && usdCny.marketTime <= now / 1000 + 300) {
      row.marketCapSortValue = row.marketCap * usdCny.price
      const fxDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(usdCny.marketTime * 1000)
      row.marketCapNote += `以USD/CNY ${usdCny.price}（${fxDate}，新浪财经${usdCny.isStale ? '保留的最近报价' : '报价'}）折算人民币参与排序；显示值仍为美元。`
    } else row.marketCapNote += '缺少可核实的人民币换算汇率，保留原币市值并暂排在已换算记录之后。'
  }
  // Unqualified zero ratios can be source sentinels. Negative P/E and P/B
  // remain negative so the UI can mark them not applicable.
  if (row.pe === 0) row.pe = null
  if (row.pb === 0) row.pb = null
  if (row.ps !== null && row.ps <= 0) row.ps = null
  if (row.dividendYield !== null && row.dividendYield < 0) row.dividendYield = null
  const timestamp = number(quote.f124)
  if (timestamp && timestamp > 946684800 && timestamp <= now / 1000 + 300) {
    row.marketTime = timestamp
    const timeZone = { US: 'America/New_York', CN: 'Asia/Shanghai', HK: 'Asia/Hong_Kong', JP: 'Asia/Tokyo', KR: 'Asia/Seoul', GB: 'Europe/London', DE: 'Europe/Berlin' }[company.market] || 'UTC'
    row.valuationDate = new Intl.DateTimeFormat('en-CA', { timeZone }).format(timestamp * 1000)
  }
  row.note = 'PE/PS为来源TTM指标；报价时间取原始行情时间，财报期未披露。股息率按数据源口径，缺失不填0。'
  if (row.pe !== null && row.pe < 0) row.note += '近12个月亏损，市盈率不适用。'
  if (row.pb !== null && row.pb < 0) row.note += '净资产为负，市净率不适用。'
  if (typeof quote.f14 === 'string' && quote.f14.trim()) row.name = quote.f14.trim()
  return row
}

export function createConstituentValuationService({ fetchImpl = fetch, fetchUsdCny = fetchCnyQuote, now = Date.now, ttl = TTL, symbolTtl = SYMBOL_TTL } = {}) {
  const cache = new Map()
  const pending = new Map()
  const symbols = new Map()
  const symbolPending = new Map()
  let active = 0
  const queue = []

  async function json(url) {
    if (active >= 6) await new Promise((resolve) => queue.push(resolve))
    active++
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) })
      if (!response.ok) throw new Error(`估值数据源返回 ${response.status}`)
      return await response.json()
    } finally {
      active--
      queue.shift()?.()
    }
  }

  async function lookupUsSymbols(companies) {
    const us = companies.filter((company) => company.market === 'US' && /^[A-Z][A-Z0-9._-]{0,20}$/.test(company.symbol))
    const missing = [...new Map(us.filter((company) => !(symbols.get(company.symbol)?.expires > now()) && !symbolPending.has(company.symbol)).map((company) => [company.symbol, company])).values()]
    if (missing.length) {
      const task = Promise.resolve().then(async () => {
        const query = new URLSearchParams({
          reportName: 'RPT_USF10_DATA_MAININDICATOR', columns: 'SECUCODE,SECURITY_CODE',
          filter: `(SECURITY_CODE in (${missing.map((company) => `"${company.symbol.replaceAll('.', '_')}"`).join(',')}))`,
          pageSize: '100', pageNumber: '1', source: 'F10', client: 'PC',
        })
        let main = null
        try {
          const body = await json(`${REPORTS}?${query}`)
          if (body.success === true && Array.isArray(body.result?.data)) main = body.result.data
        } catch { /* A failed symbol lookup does not guess a US exchange. */ }
        for (const company of missing) {
          const matches = main?.filter((row) => row.SECURITY_CODE === company.symbol.replaceAll('.', '_')) || []
          const secid = quoteSecid(company, matches.length === 1 ? matches[0] : null)
          // Listing identity changes infrequently. Quote refreshes must not
          // re-download financial reports, and lookup outages keep a verified ID.
          symbols.set(company.symbol, {
            secid: secid || symbols.get(company.symbol)?.secid || null,
            expires: now() + (secid || main ? symbolTtl : RETRY),
          })
        }
      })
      for (const company of missing) symbolPending.set(company.symbol, task)
      const cleanup = () => { for (const company of missing) symbolPending.delete(company.symbol) }
      task.then(cleanup, cleanup)
    }
    await Promise.all([...new Set(us.map((company) => symbolPending.get(company.symbol)).filter(Boolean))])
  }

  async function load(companies) {
    const result = new Map(companies.map((company) => [company.key, emptyRow(company)]))
    await lookupUsSymbols(companies)
    const securities = new Map()
    for (const company of companies) {
      const secid = company.market === 'US' ? symbols.get(company.symbol)?.secid : quoteSecid(company)
      if (secid) securities.set(company.key, secid)
      else result.set(company.key, emptyRow(company, '尚未核实此成分股在数据源中的上市代码，四项指标暂缺；不以其他上市地或存托凭证的估值替代。'))
    }
    if (securities.size) {
      const hasShanghaiB = companies.some((company) => company.market === 'CN' && /^900\d{3}(?:\.|$)/.test(company.symbol))
      const query = new URLSearchParams({
        secids: [...new Set(securities.values())].join(','), fltt: '2', invt: '2',
        fields: 'f12,f13,f14,f20,f115,f23,f130,f133,f124',
      })
      try {
        const [body, usdCny] = await Promise.all([json(`${QUOTES}?${query}`), hasShanghaiB ? fetchUsdCny().catch(() => null) : Promise.resolve(null)])
        if (body.rc !== 0 || !Array.isArray(body.data?.diff)) throw new Error('估值行情格式异常')
        for (const company of companies) {
          const secid = securities.get(company.key)
          if (!secid) continue
          const matches = body.data.diff.filter((quote) => `${quote.f13}.${quote.f12}` === secid)
          if (matches.length === 1) result.set(company.key, makeConstituentValuation(company, matches[0], secid, now(), usdCny))
        }
      } catch { /* Keep explicit missing rows and any last successful cache. */ }
    }
    for (const company of companies) {
      let row = result.get(company.key)
      const available = [row.pe, row.pb, row.ps, row.dividendYield, row.marketCap].some((value) => value !== null)
      const prior = cache.get(company.key)
      const lastGood = prior?.lastGood
      let fallbackReason = ''
      if (lastGood) {
        if (!available) fallbackReason = '本次获取失败，保留上次成功数据。'
        else if (lastGood.marketTime !== null && (row.marketTime === null || row.marketTime < lastGood.marketTime)) {
          fallbackReason = row.marketTime === null ? '本次行情时间无法核实，保留上次成功数据。' : '上游返回较早行情，保留已取得的较新数据。'
        } else if (lastGood.marketCap !== null && row.marketCap === null) fallbackReason = '本次总市值缺失，保留上次完整行情及其原始时间。'
      }
      if (fallbackReason) row = { ...lastGood, isStale: true, note: `${lastGood.note} ${fallbackReason}` }
      cache.set(company.key, {
        row, lastGood: available && !fallbackReason ? row : lastGood,
        expires: now() + (available && !fallbackReason ? ttl : RETRY),
      })
      result.set(company.key, row)
    }
    return result
  }

  return async function fetchConstituentValuations(companies, { force = false } = {}) {
    if (!Array.isArray(companies) || companies.length > 20) throw new Error('每批最多查询20项成分股')
    const missing = [...new Map(companies.filter((company) => (force || !(cache.get(company.key)?.expires > now())) && !pending.has(company.key)).map((company) => [company.key, company])).values()]
    if (missing.length) {
      const task = load(missing)
      for (const company of missing) pending.set(company.key, task)
      const cleanup = () => { for (const company of missing) pending.delete(company.key) }
      task.then(cleanup, cleanup)
    }
    await Promise.all([...new Set(companies.map((company) => pending.get(company.key)).filter(Boolean))])
    return { asOf: Math.floor(now() / 1000), rows: companies.map((company) => cache.get(company.key)?.row || emptyRow(company)) }
  }
}

export const fetchConstituentValuations = createConstituentValuationService()
