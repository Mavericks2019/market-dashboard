// 新浪在岸人民币即期参考报价；接口和字段顺序来自新浪财经自己的 hq/k SDK。
const SOURCE_URL = 'https://finance.sina.com.cn/money/forex/hq/USDCNY.shtml'
const API_URL = 'https://vip.stock.finance.sina.com.cn/forex/api/jsonp.php/var%20_data=/NewForexService.'
const REQUEST_TIMEOUT = 8_000
const QUOTE_TTL = 12_000
const HISTORY_TTL = 5 * 60_000
const cache = new Map()
const pending = new Map()
const PERIODS = new Set(['1D', '5D', '1M', '3M', '1Y', '5Y', 'MAX'])

export const CNY_INSTRUMENT = {
  key: 'USDCNY',
  symbol: 'USD/CNY',
  name: '美元兑人民币（在岸）',
  englishName: 'USD/CNY',
  contract: '在岸人民币即期参考汇率',
  kind: 'forex',
  unit: 'CNY/USD',
  currency: 'CNY',
  exchange: '在岸外汇市场',
  exchangeTimezone: 'Asia/Shanghai',
  precision: 4,
  sourceName: '新浪财经',
  sourceUrl: SOURCE_URL,
}

function positive(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null
  const result = Number(value)
  return Number.isFinite(result) && result > 0 ? result : null
}

function chinaTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?$/.test(value)) return null
  const local = value.length === 10 ? `${value} 00:00:00` : value
  const milliseconds = Date.parse(`${local.replace(' ', 'T')}+08:00`)
  if (!Number.isFinite(milliseconds)) return null
  // Reject dates silently rolled into the next month by Date.parse.
  if (new Date(milliseconds + 8 * 3600_000).toISOString().slice(0, 19) !== local.replace(' ', 'T')) return null
  return milliseconds / 1000
}

export function parseCnyJsonp(text) {
  const start = text.indexOf('=(')
  const end = text.lastIndexOf(');')
  if (start < 0 || end < start) throw new Error('人民币汇率数据格式异常')
  return JSON.parse(text.slice(start + 2, end))
}

function normalizePoints(rows) {
  const unique = new Map()
  for (const row of rows) {
    const time = chinaTime(row.date)
    const close = positive(row.close)
    if (time === null || close === null) continue
    const open = positive(row.open)
    const high = positive(row.high)
    const low = positive(row.low)
    // Broken OHLC rows cannot safely be inverted or drawn as candles.
    if (high !== null && low !== null && high < low) continue
    if (high !== null && high < Math.max(close, open ?? close)) continue
    if (low !== null && low > Math.min(close, open ?? close)) continue
    unique.set(time, { time, open, high, low, close, volume: null })
  }
  return [...unique.values()].sort((a, b) => a.time - b.time)
}

export function parseCnyDayHistory(payload) {
  if (typeof payload !== 'string') throw new Error('人民币日线数据格式异常')
  return normalizePoints(payload.split('|').map((line) => {
    const [date, open, low, high, close] = line.split(',')
    return { date, open, low, high, close }
  }))
}

export function parseCnyMinuteHistory(payload) {
  if (!Array.isArray(payload)) throw new Error('人民币分钟数据格式异常')
  return normalizePoints(payload.filter((row) => row && typeof row === 'object').map((row) => ({
    date: row.d, open: row.o, high: row.h, low: row.l, close: row.c,
  })))
}

export function parseCnyQuote(text) {
  const match = text.match(/hq_str_fx_susdcny="([^"]*)"/)
  if (!match) throw new Error('人民币即期报价为空')
  const values = match[1].split(',')
  const price = positive(values[8])
  const marketTime = chinaTime(`${values[17]} ${values[0]}`)
  if (price === null || marketTime === null) throw new Error('人民币即期报价无效')
  const previousClose = positive(values[3])
  const change = previousClose === null ? null : price - previousClose
  return {
    price,
    previousClose,
    change,
    changePercent: change === null ? null : change / previousClose * 100,
    open: positive(values[5]),
    dayHigh: positive(values[6]),
    dayLow: positive(values[7]),
    marketTime,
  }
}

// Before 06:00 China time belongs to the preceding FX session. This keeps
// the 00:00–03:00 continuation together with the preceding daytime session.
function sessionDate(time) {
  return new Date((time + 2 * 3600) * 1000).toISOString().slice(0, 10)
}

export function selectCnyPoints(points, period) {
  if (!PERIODS.has(period)) throw new Error(`不支持的人民币汇率周期 ${period}`)
  if (!points.length) return []
  if (period === '1D' || period === '5D') {
    const sessions = [...new Set(points.map((point) => sessionDate(point.time)))]
    const included = new Set(sessions.slice(period === '1D' ? -1 : -5))
    return points.filter((point) => included.has(sessionDate(point.time)))
  }
  const days = { '1M': 32, '3M': 95, '1Y': 370, '5Y': 1900 }[period]
  const cutoff = days ? points.at(-1).time - days * 86_400 : 0
  return points.filter((point) => point.time >= cutoff)
}

async function getText(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    headers: { Referer: SOURCE_URL, 'User-Agent': 'Mozilla/5.0 Market Dashboard' },
  })
  if (!response.ok) throw new Error(`人民币汇率服务返回 ${response.status}`)
  return new TextDecoder('gb18030').decode(await response.arrayBuffer())
}

async function cachedFetch(key, ttl, fetcher) {
  const saved = cache.get(key)
  if (saved && Date.now() - saved.time < ttl) return { data: saved.data, isStale: false }
  if (pending.has(key)) return pending.get(key)
  const request = (async () => {
    try {
      const data = await fetcher()
      cache.set(key, { data, time: Date.now() })
      return { data, isStale: false }
    } catch (error) {
      if (saved) return { data: saved.data, isStale: true }
      throw error
    } finally {
      pending.delete(key)
    }
  })()
  pending.set(key, request)
  return request
}

export async function fetchCnyQuote() {
  const result = await cachedFetch('quote', QUOTE_TTL, async () => parseCnyQuote(await getText('https://hq.sinajs.cn/list=fx_susdcny')))
  return { ...result.data, isStale: result.isStale }
}

function fetchDaily() {
  return cachedFetch('daily', HISTORY_TTL, async () => {
    const points = parseCnyDayHistory(parseCnyJsonp(await getText(`${API_URL}getDayKLine?symbol=fx_susdcny`)))
    if (!points.length) throw new Error('人民币日线数据为空')
    return points
  })
}

function fetchMinutes(period) {
  const scale = period === '1D' ? 1 : 5
  return cachedFetch(`minutes:${scale}`, QUOTE_TTL, async () => {
    const points = parseCnyMinuteHistory(parseCnyJsonp(await getText(`${API_URL}getMinKline?symbol=fx_susdcny&scale=${scale}&datalen=${scale === 1 ? 3000 : 1800}`)))
    if (!points.length) throw new Error('人民币分钟数据为空')
    return points
  })
}

export async function fetchCnyTrend(period = 'MAX') {
  if (!PERIODS.has(period)) throw new Error(`不支持的人民币汇率周期 ${period}`)
  const intraday = period === '1D' || period === '5D'
  const [dailyResult, quoteResult, minuteResult] = await Promise.allSettled([
    fetchDaily(), fetchCnyQuote(), intraday ? fetchMinutes(period) : Promise.resolve(null),
  ])
  const daily = dailyResult.status === 'fulfilled' ? dailyResult.value : null
  const quote = quoteResult.status === 'fulfilled' ? quoteResult.value : null
  const minute = minuteResult.status === 'fulfilled' ? minuteResult.value : null
  if (!daily && !quote && !minute) throw new Error('人民币即期报价与历史数据均暂时不可用')
  const fullPoints = intraday ? minute?.data ?? [] : daily?.data ?? []
  const points = selectCnyPoints(fullPoints, period)
  const lastDaily = daily?.data.at(-1)
  const previousDaily = daily?.data.at(-2)
  const latestHistory = lastDaily ?? points.at(-1)
  const useQuote = quote && (!latestHistory || quote.marketTime >= latestHistory.time)
  const price = useQuote ? quote.price : latestHistory?.close ?? null
  const previousClose = useQuote ? quote.previousClose : previousDaily?.close ?? null
  const change = price !== null && previousClose !== null ? price - previousClose : null
  const isStale = Boolean(daily?.isStale || quote?.isStale || minute?.isStale || !quote || !daily || (intraday && !minute))
  const historyStart = daily?.data[0]?.time ?? fullPoints[0]?.time ?? null
  const startDate = historyStart === null ? null : new Date((historyStart + 8 * 3600) * 1000).toISOString().slice(0, 10)
  const notes = [
    '在岸即期参考汇率。',
    daily && startDate ? `数据源可用日线始于 ${startDate}。` : '历史日线暂时不可用。',
    isStale ? '部分数据刷新失败，展示最后可用数据；请以报价时间为准。' : '休市期间保留最后报价。',
  ]
  return {
    ...CNY_INSTRUMENT,
    price,
    previousClose,
    change,
    changePercent: change !== null && previousClose ? change / previousClose * 100 : null,
    dayHigh: useQuote ? quote.dayHigh : lastDaily?.high ?? null,
    dayLow: useQuote ? quote.dayLow : lastDaily?.low ?? null,
    marketTime: useQuote ? quote.marketTime : latestHistory?.time ?? null,
    historyStart,
    historyEnd: daily?.data.at(-1)?.time ?? fullPoints.at(-1)?.time ?? null,
    dataGranularity: intraday ? period === '1D' ? '1m' : '5m' : '1d',
    frequency: intraday ? `${period === '1D' ? '1' : '5'} 分钟线` : '日线',
    dataNote: notes.join(' '),
    isStale,
    points,
  }
}
