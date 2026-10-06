// HSTECH is the cash price index itself, not a tracking ETF or the Hang Seng Index.
const SOURCE_URL = 'https://quote.eastmoney.com/gb/zsHSTECH.html'
const HISTORY_URL = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=124.HSTECH&klt=101&fqt=0&beg=0&end=20500101&lmt=10000&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56'
const TENCENT_DAILY_URL = 'https://web.ifzq.gtimg.cn/appstock/app/hkfqkline/get?param=hkHSTECH,day,,,2000,qfq'
const TENCENT_MINUTE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/day/query?code=hkHSTECH'
const SINA_QUOTE_URL = 'https://hq.sinajs.cn/list=rt_hkHSTECH'
const TENCENT_QUOTE_URL = 'https://qt.gtimg.cn/q=hkHSTECH'
const PERIODS = new Set(['1D', '5D', '1M', '3M', '1Y', '5Y', 'MAX'])
const LAUNCH_DATE = '2020-07-27'

export const HSTECH_INSTRUMENT = {
  key: 'HSTECH', symbol: 'HSTECH', name: '恒生科技指数', englishName: 'Hang Seng TECH Index',
  contract: '恒生科技价格指数', kind: 'index', unit: '点', currency: 'HKD',
  exchange: '恒生指数公司', exchangeTimezone: 'Asia/Hong_Kong', precision: 2,
  sourceName: '东方财富 / 新浪财经 / 腾讯财经', sourceUrl: SOURCE_URL,
}

function positive(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function hkTime(value) {
  if (typeof value !== 'string') return null
  let text = value.replaceAll('/', '-')
  if (/^\d{8}$/.test(text)) text = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}`
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) text += ' 00:00:00'
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(text)) text += ':00'
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) return null
  const time = Date.parse(`${text.replace(' ', 'T')}+08:00`)
  if (!Number.isFinite(time) || new Date(time + 8 * 3600_000).toISOString().slice(0, 19) !== text.replace(' ', 'T')) return null
  return time / 1000
}

function hkDate(time) {
  return new Date((time + 8 * 3600) * 1000).toISOString().slice(0, 10)
}

function normalizePoints(rows) {
  const unique = new Map()
  for (const row of rows) {
    let time = hkTime(row.date)
    // Daily chart timestamps are date labels: UTC midnight keeps the same date
    // on lightweight-charts' UTC axis and in Hong Kong's tooltip.
    if (time !== null && /^\d{4}-\d{2}-\d{2}$/.test(row.date)) time += 8 * 3600
    const close = positive(row.close)
    if (time === null || close === null) continue
    const open = positive(row.open)
    const high = positive(row.high)
    const low = positive(row.low)
    if (high !== null && high < Math.max(close, open ?? close)) continue
    if (low !== null && low > Math.min(close, open ?? close)) continue
    if (low !== null && high !== null && low > high) continue
    unique.set(time, { time, open, high, low, close, volume: null })
  }
  return [...unique.values()].sort((a, b) => a.time - b.time)
}

export function parseHstechDaily(payload) {
  if (payload?.rc !== 0 || payload?.data?.code !== 'HSTECH' || !Array.isArray(payload.data.klines)) {
    throw new Error('恒生科技日线数据格式或指数代码异常')
  }
  const points = normalizePoints(payload.data.klines.filter((row) => typeof row === 'string').map((row) => {
    const [date, open, close, high, low] = row.split(',')
    // Pre-launch history is backtested closing levels, not intraday OHLC observations.
    return date < LAUNCH_DATE ? { date, close } : { date, open, close, high, low }
  }))
  if (!points.length) throw new Error('恒生科技日线为空')
  return points
}

function parseTencentDaily(payload) {
  const rows = payload?.data?.hkHSTECH?.day
  if (payload?.code !== 0 || !Array.isArray(rows)) throw new Error('恒生科技备用日线异常')
  const points = normalizePoints(rows.filter(Array.isArray).map(([date, open, close, high, low]) => ({ date, open, close, high, low })))
  if (!points.length) throw new Error('恒生科技备用日线为空')
  return points
}

export function parseHstechMinutes(payload) {
  const sessions = payload?.data?.hkHSTECH?.data
  if (payload?.code !== 0 || !Array.isArray(sessions)) throw new Error('恒生科技分时数据异常')
  const rows = []
  for (const session of sessions) {
    if (!/^\d{8}$/.test(session?.date) || !Array.isArray(session.data)) continue
    const date = `${session.date.slice(0, 4)}-${session.date.slice(4, 6)}-${session.date.slice(6)}`
    for (const entry of session.data) {
      if (typeof entry !== 'string') continue
      const [clock, close] = entry.split(/\s+/)
      if (!/^\d{4}$/.test(clock)) continue
      rows.push({ date: `${date} ${clock.slice(0, 2)}:${clock.slice(2)}:00`, close })
    }
  }
  const points = normalizePoints(rows)
  if (!points.length) throw new Error('恒生科技分时为空')
  return points
}

function quoteFromValues(price, previousClose, open, dayHigh, dayLow, clock) {
  price = positive(price)
  previousClose = positive(previousClose)
  const marketTime = hkTime(clock)
  if (price === null || marketTime === null) throw new Error('恒生科技报价无效')
  const change = previousClose === null ? null : price - previousClose
  return { price, previousClose, open: positive(open), dayHigh: positive(dayHigh), dayLow: positive(dayLow),
    change, changePercent: change === null ? null : change / previousClose * 100, marketTime }
}

export function parseHstechQuote(text) {
  const match = text.match(/hq_str_rt_hkHSTECH="([^"]*)"/)
  if (!match) throw new Error('恒生科技报价为空')
  const values = match[1].split(',')
  if (values[0] !== 'HSTECH') throw new Error('恒生科技报价代码异常')
  return quoteFromValues(values[6], values[3], values[2], values[4], values[5], `${values[17]} ${values[18]}`)
}

function parseTencentQuote(text) {
  const match = text.match(/v_hkHSTECH="([^"]*)"/)
  if (!match) throw new Error('恒生科技备用报价为空')
  const values = match[1].split('~')
  if (values[2] !== 'HSTECH') throw new Error('恒生科技备用报价代码异常')
  return quoteFromValues(values[3], values[4], values[5], values[33], values[34], values[30])
}

export function selectHstechPoints(points, period) {
  if (!PERIODS.has(period)) throw new Error(`不支持的恒生科技周期 ${period}`)
  if (!points.length) return []
  if (period === '1D' || period === '5D') {
    const days = [...new Set(points.map((point) => hkDate(point.time)))]
    const selected = new Set(days.slice(period === '1D' ? -1 : -5))
    return points.filter((point) => selected.has(hkDate(point.time)))
  }
  const days = { '1M': 32, '3M': 95, '1Y': 370, '5Y': 1900 }[period]
  return days ? points.filter((point) => point.time >= points.at(-1).time - days * 86400) : points
}

export function createHstechClient({ fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 8000, quoteTtlMs = 12000, historyTtlMs = 300000 } = {}) {
  const cache = new Map()
  const pending = new Map()
  async function getText(url) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: {
      Referer: url.includes('sina') ? 'https://finance.sina.com.cn/' : SOURCE_URL,
      'User-Agent': 'Mozilla/5.0 Market Dashboard',
    } })
    if (!response.ok) throw new Error(`恒生科技数据服务返回 ${response.status}`)
    return new TextDecoder('gb18030').decode(await response.arrayBuffer())
  }
  async function cachedFetch(key, ttl, fetcher) {
    const saved = cache.get(key)
    if (saved && now() - saved.time < ttl) return { data: saved.data, isStale: Boolean(saved.data.partialRefresh) }
    if (pending.has(key)) return pending.get(key)
    const request = (async () => {
      try {
        const data = await fetcher(saved?.data)
        cache.set(key, { data, time: now() })
        return { data, isStale: Boolean(data.partialRefresh) }
      } catch (error) {
        if (saved) return { data: saved.data, isStale: true }
        throw error
      } finally { pending.delete(key) }
    })()
    pending.set(key, request)
    return request
  }
  function daily() {
    return cachedFetch('daily', historyTtlMs, async (saved) => {
      try {
        const points = parseHstechDaily(JSON.parse(await getText(HISTORY_URL)))
        return { points, sourceName: '东方财富', partialRefresh: false }
      } catch {
        const fresh = parseTencentDaily(JSON.parse(await getText(TENCENT_DAILY_URL)))
        const unique = new Map([...(saved?.points ?? []), ...fresh].map((point) => [point.time, point]))
        return { points: [...unique.values()].sort((a, b) => a.time - b.time), sourceName: saved ? '东方财富 / 腾讯财经' : '腾讯财经', partialRefresh: true }
      }
    })
  }
  function quote() {
    return cachedFetch('quote', quoteTtlMs, async () => {
      try { return { ...parseHstechQuote(await getText(SINA_QUOTE_URL)), sourceName: '新浪财经' } }
      catch { return { ...parseTencentQuote(await getText(TENCENT_QUOTE_URL)), sourceName: '腾讯财经' } }
    })
  }
  function minutes() {
    return cachedFetch('minutes', quoteTtlMs, async () => parseHstechMinutes(JSON.parse(await getText(TENCENT_MINUTE_URL))))
  }
  return async function fetchHstechTrend(period = 'MAX') {
    if (!PERIODS.has(period)) throw new Error(`不支持的恒生科技周期 ${period}`)
    const intraday = period === '1D' || period === '5D'
    const [dailyResult, quoteResult, minuteResult] = await Promise.allSettled([daily(), quote(), intraday ? minutes() : Promise.resolve(null)])
    const history = dailyResult.status === 'fulfilled' ? dailyResult.value : null
    const snapshot = quoteResult.status === 'fulfilled' ? quoteResult.value : null
    const minute = minuteResult.status === 'fulfilled' ? minuteResult.value : null
    if (!history && !snapshot && !minute) throw new Error('恒生科技报价与历史数据暂不可用')
    const fullHistory = history?.data.points ?? []
    const lastDaily = fullHistory.at(-1)
    const previousDaily = fullHistory.at(-2)
    const lastMinute = minute?.data.at(-1)
    const latest = lastMinute && (!lastDaily || lastMinute.time > lastDaily.time) ? lastMinute : lastDaily
    // The minute feed labels its in-progress observation with the following minute.
    // Prefer the actual quote clock for the same session instead of exposing that label as a live timestamp.
    const useQuote = snapshot && (!latest || hkDate(snapshot.data.marketTime) >= hkDate(latest.time))
    const value = useQuote ? snapshot.data : null
    const price = value?.price ?? latest?.close ?? null
    const historyPreviousClose = latest && lastDaily && hkDate(latest.time) !== hkDate(lastDaily.time) ? lastDaily.close : previousDaily?.close ?? null
    const previousClose = value?.previousClose ?? historyPreviousClose
    const change = price !== null && previousClose !== null ? price - previousClose : null
    const historyStart = fullHistory[0]?.time ?? null
    const actualMinutes = intraday && minute
    const isStale = Boolean(!history || !snapshot || history?.isStale || snapshot?.isStale || (intraday && (!minute || minute.isStale)))
    const notes = [
      '2020-07-27 正式发布，基期 2014-12-31=3000；发布前为回溯计算的收盘指数。',
      historyStart === null ? '完整日线历史暂不可用。' : `可用历史始于 ${hkDate(historyStart)}。`,
      '报价和分时可能延迟，请以行情时间为准；休市保留最后报价。',
      intraday && !minute ? '分时暂不可用，展示相应交易日的日线。' : '',
      isStale ? '部分数据刷新失败，显示最后可用数据。' : '',
    ].filter(Boolean)
    return {
      ...HSTECH_INSTRUMENT,
      price, previousClose, change, changePercent: change !== null && previousClose ? change / previousClose * 100 : null,
      open: value?.open ?? lastDaily?.open ?? null, dayHigh: value?.dayHigh ?? lastDaily?.high ?? null,
      dayLow: value?.dayLow ?? lastDaily?.low ?? null, marketTime: value?.marketTime ?? latest?.time ?? null,
      historyStart, historyEnd: lastDaily?.time ?? null,
      points: selectHstechPoints(actualMinutes ? minute.data : fullHistory, period),
      dataGranularity: actualMinutes ? '1m' : '1d', frequency: actualMinutes ? '分钟分时（可能延迟）' : '日线',
      sourceName: [...new Set([history?.data.sourceName, snapshot?.data.sourceName, actualMinutes ? '腾讯财经' : null].filter(Boolean))].join(' / '),
      sourceUrl: history?.data.sourceName === '腾讯财经' ? 'https://gu.qq.com/hkHSTECH/zs' : SOURCE_URL,
      dataNote: notes.join(' '), isStale,
    }
  }
}

export const fetchHstechTrend = createHstechClient()
