import { zonedTimeToEpoch } from './us-session.mjs'

const TIMEOUT = 10_000
const QUOTE_TTL = 12_000
const HISTORY_TTL = 5 * 60_000
const DAY = 86_400_000
const PERIODS = new Set(['1D', '5D', '1M', '3M', '1Y', '5Y', 'MAX'])
const OFFICIAL_URL = 'https://indexes.nasdaqomx.com/Index/Overview/HXC'
const SINA_DAILY = 'https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var%20_data=/US_MinKService.getDailyK?symbol=.HXC'
const SINA_MINUTES = 'https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var%20_data=/US_MinKService.getMinK?symbol=.HXC&type=5'
const EASTMONEY_QUOTE = 'https://push2.eastmoney.com/api/qt/stock/get?secid=251.HXC&fields=f43,f44,f45,f46,f57,f58,f59,f60,f86,f107'
const EASTMONEY_MINUTES = 'https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=251.HXC&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=5&iscr=0'

export const HXC_INSTRUMENT = {
  key: 'HXC', symbol: 'HXC', name: '纳斯达克中国金龙指数', englishName: 'Nasdaq Golden Dragon China Index',
  contract: 'Nasdaq Golden Dragon China Price Index', kind: 'index', unit: '点', currency: 'USD',
  exchange: 'NASDAQ', exchangeTimezone: 'America/New_York', precision: 2,
}

function fail(message) { throw new Error(`中国金龙指数：${message}`) }
function number(value, positive = false) {
  if (value === null || value === undefined || String(value).trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && (!positive || parsed > 0) ? parsed : null
}
function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const time = Date.parse(`${date}T00:00:00Z`)
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date
}
function dailyTime(date) {
  if (!validDate(date)) fail('日线日期无效')
  // Noon UTC keeps the date in New York on both EST and EDT.
  return Date.parse(`${date}T12:00:00Z`) / 1000
}
function localTime(text, timezone) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(text) || !validDate(text.slice(0, 10))) fail('行情时间格式无效')
  try { return zonedTimeToEpoch(text.replace(' ', 'T'), timezone) / 1000 } catch { fail('行情时间无效') }
}
function tradingDate(time) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time * 1000))
}
function uniqueAscending(points) {
  const sorted = points.toSorted((a, b) => a.time - b.time)
  if (!sorted.length) fail('历史数据为空')
  for (let index = 1; index < sorted.length; index += 1) if (sorted[index].time === sorted[index - 1].time) fail('历史日期重复')
  return sorted
}
function bar(time, close, high = null, low = null, open = null) {
  const validHigh = number(high, true)
  const validLow = number(low, true)
  return { time, close, open: number(open, true), high: validHigh !== null && validHigh >= close ? validHigh : null, low: validLow !== null && validLow <= close ? validLow : null, volume: null }
}
function parseJsonp(text) {
  const match = String(text).match(/\bvar\s+_data\s*=\s*\(([\s\S]*)\);\s*$/)
  if (!match) fail('新浪历史响应格式异常')
  let value
  try { value = JSON.parse(match[1]) } catch { fail('新浪历史响应不是 JSON') }
  if (!Array.isArray(value) || !value.length) fail('新浪历史响应为空')
  return value
}

/** Nasdaq's chart Open field is the prior close, and Change is a range return; neither is OHLC. */
export function parseHxcOfficialHistory(rows) {
  if (!Array.isArray(rows) || !rows.length) fail('官方历史数据为空')
  return uniqueAscending(rows.map((row) => {
    if (row?.FPSymbol !== 'HXC') fail('官方指数身份校验失败')
    if (!Number.isSafeInteger(row.x) || row.x % DAY !== 0 || row.x < Date.parse('2003-09-30T00:00:00Z')) fail('官方历史日期无效')
    const close = number(row.y, true)
    if (close === null) fail('官方指数点位无效')
    return bar(dailyTime(new Date(row.x).toISOString().slice(0, 10)), close, row.High, row.Low)
  }))
}

export function parseHxcSinaHistory(text, intraday = false) {
  return uniqueAscending(parseJsonp(text).map((row) => {
    const close = number(row?.c, true)
    if (close === null) fail('新浪指数点位无效')
    const time = intraday ? localTime(row.d, 'America/New_York') : dailyTime(row.d)
    return bar(time, close, row.h, row.l, row.o)
  }))
}

function validName(value) { return typeof value === 'string' && value.replace(/\s+/g, '') === HXC_INSTRUMENT.name }
function emIdentity(data, snapshot = false) {
  if (!data || (snapshot ? data.f57 !== 'HXC' || data.f107 !== 251 || !validName(data.f58) : data.code !== 'HXC' || data.market !== 251 || !validName(data.name))) fail('东方财富指数身份校验失败')
}

export function parseHxcEastmoneyQuote(payload) {
  const data = payload?.data
  emIdentity(data, true)
  if (!Number.isInteger(data.f59) || data.f59 < 0 || data.f59 > 8) fail('报价小数位无效')
  const scale = 10 ** data.f59
  const price = number(data.f43, true)
  const previousClose = number(data.f60, true)
  if (price === null || previousClose === null || !Number.isSafeInteger(data.f86) || data.f86 <= 0) fail('报价或原始时间缺失')
  return {
    price: price / scale, previousClose: previousClose / scale,
    dayHigh: number(data.f44, true) === null ? null : Number(data.f44) / scale,
    dayLow: number(data.f45, true) === null ? null : Number(data.f45) / scale,
    marketTime: data.f86,
  }
}

export function parseHxcSinaQuote(text) {
  // gb_hxc is a different listed security. The literal dollar sign is required for the index.
  const match = String(text).match(/\bvar hq_str_gb_\$hxc="([^"]*)";/)
  const fields = match?.[1].split(',')
  if (!fields || !validName(fields[0])) fail('新浪指数身份校验失败')
  const price = number(fields[1], true)
  const previousClose = number(fields[26], true)
  if (price === null || previousClose === null) fail('新浪指数报价无效')
  return {
    price, previousClose, dayHigh: number(fields[6], true), dayLow: number(fields[7], true),
    // This snapshot timestamp is China Standard Time, unlike the US MinK rows.
    marketTime: localTime(fields[3], 'Asia/Shanghai'),
  }
}

export function parseHxcEastmoneyMinutes(payload) {
  const data = payload?.data
  emIdentity(data)
  if (!Array.isArray(data.trends) || !data.trends.length) fail('东方财富分时数据为空')
  return uniqueAscending(data.trends.map((row) => {
    if (typeof row !== 'string') fail('东方财富分时格式异常')
    const fields = row.split(',')
    const close = number(fields[2], true)
    if (fields.length < 5 || close === null) fail('东方财富分时点位无效')
    return bar(localTime(fields[0], 'Asia/Shanghai'), close, fields[3], fields[4], fields[1])
  }))
}

function slicePeriod(points, period, intraday = false) {
  if (period === '1D' || period === '5D') {
    const dayOf = (point) => intraday ? tradingDate(point.time) : new Date(point.time * 1000).toISOString().slice(0, 10)
    const days = [...new Set(points.map(dayOf))]
    const first = days.at(period === '1D' ? -1 : -5) ?? days[0]
    return points.filter((point) => dayOf(point) >= first)
  }
  const days = { '1M': 32, '3M': 95, '1Y': 370, '5Y': 1900 }[period]
  return days ? points.filter((point) => point.time >= points.at(-1).time - days * 86400) : points
}

export function createHxcAdapter({ fetchImpl = fetch, now = Date.now } = {}) {
  const cache = new Map()
  const pending = new Map()
  async function getText(url, options = {}, encoding = 'utf-8') {
    const response = await fetchImpl(url, {
      ...options, signal: AbortSignal.timeout(TIMEOUT),
      headers: { Referer: 'https://finance.sina.com.cn/', 'User-Agent': 'Mozilla/5.0 Market Dashboard', ...options.headers },
    })
    if (!response.ok) fail(`数据源返回 ${response.status}`)
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > 3_000_000) fail('数据响应过大')
    return new TextDecoder(encoding).decode(buffer)
  }
  async function cached(key, ttl, request) {
    const previous = cache.get(key)
    if (previous && now() < previous.expiresAt) return previous
    if (pending.has(key)) return pending.get(key)
    const task = (async () => {
      try {
        const result = await request(previous)
        const value = { ...result, isStale: false, expiresAt: now() + ttl }
        cache.set(key, value)
        return value
      } catch (error) {
        if (!previous) throw error
        const value = { ...previous, isStale: true, expiresAt: now() + Math.min(ttl, 60_000) }
        cache.set(key, value)
        return value
      } finally { pending.delete(key) }
    })()
    pending.set(key, task)
    return task
  }
  function history() {
    return cached('history', HISTORY_TTL, async (previous) => {
      try {
        const endDate = new Date(now()).toISOString().slice(0, 10)
        const text = await getText('https://indexes.nasdaqomx.com/Index/HistoryChartData', {
          method: 'POST', body: new URLSearchParams({ id: 'HXC', startDate: '2003-09-30T00:00:00', endDate: `${endDate}T00:00:00` }),
          headers: { Referer: OFFICIAL_URL, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
        })
        const data = parseHxcOfficialHistory(JSON.parse(text))
        if (previous && (data[0].time > previous.data[0].time || data.at(-1).time < previous.data.at(-1).time)) fail('官方历史覆盖范围倒退')
        return { data, sourceName: 'Nasdaq 官方历史', sourceUrl: OFFICIAL_URL }
      } catch (error) {
        if (previous) throw error
        return { data: parseHxcSinaHistory(await getText(SINA_DAILY)), sourceName: '新浪财经备用日线', sourceUrl: 'https://stock.finance.sina.com.cn/usstock/quotes/.HXC.html' }
      }
    })
  }
  function quote() {
    return cached('quote', QUOTE_TTL, async () => {
      try { return { data: parseHxcEastmoneyQuote(JSON.parse(await getText(EASTMONEY_QUOTE))), sourceName: '东方财富报价' } }
      catch { return { data: parseHxcSinaQuote(await getText('https://hq.sinajs.cn/list=gb_$hxc', {}, 'gb18030')), sourceName: '新浪财经备用报价' } }
    })
  }
  function minutes() {
    return cached('minutes', QUOTE_TTL, async () => {
      try { return { data: parseHxcEastmoneyMinutes(JSON.parse(await getText(EASTMONEY_MINUTES))), sourceName: '东方财富分时', granularity: '1m' } }
      catch { return { data: parseHxcSinaHistory(await getText(SINA_MINUTES), true), sourceName: '新浪财经备用分时', granularity: '5m' } }
    })
  }
  async function fetchTrend(period = 'MAX') {
    if (!PERIODS.has(period)) fail('未知周期')
    const intraday = period === '1D' || period === '5D'
    const [dailyResult, quoteResult, minuteResult] = await Promise.allSettled([
      history(), quote(), intraday ? minutes() : Promise.resolve(null),
    ])
    if (dailyResult.status === 'rejected') throw dailyResult.reason
    const daily = dailyResult.value
    const snapshot = quoteResult.status === 'fulfilled' ? quoteResult.value : null
    const minuteData = minuteResult.status === 'fulfilled' ? minuteResult.value : null
    const latestDaily = daily.data.at(-1)
    const price = snapshot?.data.price ?? latestDaily.close
    const previousClose = snapshot?.data.previousClose ?? daily.data.at(-2)?.close ?? null
    const change = previousClose === null ? null : price - previousClose
    const startDate = new Date(daily.data[0].time * 1000).toISOString().slice(0, 10)
    const notes = [
      'HXC 为纳斯达克中国金龙价格指数，不包含现金红利再投资；基期为2003-09-30，基点2500。',
      `当前数据源历史自 ${startDate} 起，未覆盖基期至首个可用历史日之间的数据。`,
      '休市时保留最近指数报价。免费行情可能存在延迟，时间以来源为准。',
    ]
    if (intraday && !minuteData) notes.push('分时源暂不可用，显示最近交易日的真实日线。')
    if (minuteData?.granularity === '5m') notes.push('当前使用备用5分钟行情，日终指数值可能与最后分时点略有差异。')
    const isStale = daily.isStale || !snapshot || snapshot.isStale || Boolean(intraday && (!minuteData || minuteData.isStale))
    if (isStale) notes.push('部分上游刷新失败，保留最近可用数据及原始时间。')
    return {
      ...HXC_INSTRUMENT, price, previousClose, change,
      changePercent: change === null ? null : change / previousClose * 100,
      dayHigh: snapshot?.data.dayHigh ?? latestDaily.high, dayLow: snapshot?.data.dayLow ?? latestDaily.low,
      marketTime: snapshot?.data.marketTime ?? latestDaily.time,
      historyStart: daily.data[0].time, historyEnd: latestDaily.time,
      dataGranularity: minuteData?.granularity ?? '1d', sourceName: [daily.sourceName, snapshot?.sourceName, minuteData?.sourceName].filter(Boolean).join(' / '),
      sourceUrl: daily.sourceUrl, dataNote: notes.join(' '), isStale,
      points: slicePeriod(minuteData?.data ?? daily.data, period, Boolean(minuteData)),
    }
  }
  return { fetchTrend }
}

const adapter = createHxcAdapter()
export const fetchHxcTrend = adapter.fetchTrend
