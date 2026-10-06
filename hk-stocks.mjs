import { readFile } from 'node:fs/promises'

const TIMEOUT = 8_000
const QUOTE_TTL = 12_000
const HISTORY_TTL = 5 * 60_000
const PERIODS = new Set(['1D', '5D', '1M', '3M', '1Y', '5Y', 'MAX'])
const COMMON = { kind: 'stock', unit: 'HKD/股', currency: 'HKD', exchange: 'HKEX', exchangeTimezone: 'Asia/Hong_Kong', precision: 2 }
export const HK_STOCKS_INSTRUMENTS = {
  HSBC: { ...COMMON, key: 'HSBC', symbol: '00005.HK', sourceSymbol: '00005', name: '汇丰控股', englishName: 'HSBC Holdings', contract: '汇丰控股港股普通股' },
  STAN: { ...COMMON, key: 'STAN', symbol: '02888.HK', sourceSymbol: '02888', name: '渣打集团', englishName: 'Standard Chartered', contract: '渣打集团港股普通股' },
}

function numeric(value, positive = false) {
  if (value === null || value === undefined || String(value).trim() === '') return null
  const result = Number(value)
  return Number.isFinite(result) && (!positive || result > 0) ? result : null
}

function dateText(value) {
  const text = String(value ?? '').replaceAll('/', '-')
  return /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}` : text
}

function timestamp(date, clock = null) {
  const day = dateText(date)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  // Daily bars are calendar dates (UTC midnight), not an alleged trade time.
  // Actual quotes/minutes retain their original Hong Kong local time.
  const milliseconds = Date.parse(`${day}T${clock ?? '00:00:00'}${clock === null ? 'Z' : '+08:00'}`)
  if (!Number.isFinite(milliseconds)) return null
  const local = new Date(milliseconds + (clock === null ? 0 : 8 * 3600_000)).toISOString()
  if (local.slice(0, 10) !== day || (clock !== null && local.slice(11, 19) !== clock)) return null
  return milliseconds / 1000
}

function uniqueSorted(points) {
  return [...new Map(points.map((point) => [point.time, point])).values()].sort((a, b) => a.time - b.time)
}

/** Tencent's no-adjustment day rows are date, open, close, high, low, volume. */
export function parseHkDailyRows(rows) {
  if (!Array.isArray(rows)) throw new Error('港股历史数据格式异常')
  return uniqueSorted(rows.flatMap((row) => {
    if (!Array.isArray(row)) return []
    const time = timestamp(row[0])
    const close = numeric(row[2], true)
    const open = numeric(row[1], true)
    const high = numeric(row[3], true)
    const low = numeric(row[4], true)
    const volume = numeric(row[5])
    if (time === null || close === null) return []
    if (high !== null && high < Math.max(close, open ?? close)) return []
    if (low !== null && low > Math.min(close, open ?? close)) return []
    return [{ time, open, close, high, low, volume: volume !== null && volume >= 0 ? volume : null }]
  }))
}

/** Minute volumes in the source are cumulative; convert to each minute's volume. */
export function parseHkMinuteSessions(sessions) {
  if (!Array.isArray(sessions)) throw new Error('港股分时数据格式异常')
  const result = []
  for (const session of sessions) {
    const rows = new Map()
    for (const line of session?.data ?? []) {
      if (typeof line !== 'string') continue
      const [clock, rawClose, rawVolume] = line.trim().split(/\s+/)
      if (!/^\d{4}$/.test(clock)) continue
      const time = timestamp(session.date, `${clock.slice(0, 2)}:${clock.slice(2)}:00`)
      const close = numeric(rawClose, true)
      if (time === null || close === null) continue
      rows.set(time, { time, close, cumulative: numeric(rawVolume) })
    }
    let previousVolume = 0
    for (const row of [...rows.values()].sort((a, b) => a.time - b.time)) {
      const volume = row.cumulative !== null && row.cumulative >= previousVolume ? row.cumulative - previousVolume : null
      if (row.cumulative !== null) previousVolume = row.cumulative
      result.push({ time: row.time, open: null, high: null, low: null, close: row.close, volume })
    }
  }
  return uniqueSorted(result)
}

export function parseHkStockQuotes(text) {
  const quotes = new Map()
  for (const [key, instrument] of Object.entries(HK_STOCKS_INSTRUMENTS)) {
    const match = text.match(new RegExp(`hq_str_rt_hk${instrument.sourceSymbol}="([^"]*)"`))
    if (!match) continue
    const fields = match[1].split(',')
    const price = numeric(fields[6], true)
    const clock = /^\d{2}:\d{2}$/.test(fields[18]) ? `${fields[18]}:00` : fields[18]
    if (!/^\d{2}:\d{2}:\d{2}$/.test(clock)) continue
    const marketTime = timestamp(fields[17], clock)
    if (price === null || marketTime === null) continue
    const previousClose = numeric(fields[3], true)
    const change = previousClose === null ? null : price - previousClose
    quotes.set(key, {
      price, previousClose, change, changePercent: change === null ? null : change / previousClose * 100,
      open: numeric(fields[2], true), dayHigh: numeric(fields[4], true), dayLow: numeric(fields[5], true),
      volume: numeric(fields[12]), marketTime, isStale: false,
    })
  }
  return quotes
}

function slicePeriod(points, period, intraday = false) {
  if (period === '1D' || period === '5D') {
    const days = [...new Set(points.map((point) => new Date(point.time * 1000 + (intraday ? 8 * 3600_000 : 0)).toISOString().slice(0, 10)))]
    const first = days.at(period === '1D' ? -1 : -5) ?? days[0]
    return points.filter((point) => new Date(point.time * 1000 + (intraday ? 8 * 3600_000 : 0)).toISOString().slice(0, 10) >= first)
  }
  const days = { '1M': 32, '3M': 95, '1Y': 370, '5Y': 1900 }[period]
  return days ? points.filter((point) => point.time >= points.at(-1).time - days * 86400) : points
}

/** Dependency injection keeps network failure and cache recovery testable. */
export function createHkStocksAdapter({ fetchImpl = fetch, now = Date.now, loadHistory = async (symbol) => JSON.parse(await readFile(new URL(`./data/hk-stocks/${symbol}.json`, import.meta.url), 'utf8')) } = {}) {
  const cache = new Map()
  const pending = new Map()
  async function getText(url, encoding = 'utf-8') {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT), headers: { Referer: 'https://finance.sina.com.cn/', 'User-Agent': 'Mozilla/5.0 Market Dashboard' } })
    if (!response.ok) throw new Error(`港股行情服务返回 ${response.status}`)
    return new TextDecoder(encoding).decode(await response.arrayBuffer())
  }
  async function cachedRequest(key, ttl, request, fallback) {
    const existing = cache.get(key)
    if (existing && now() - existing.fetchedAt < ttl) return existing
    if (pending.has(key)) return pending.get(key)
    const task = (async () => {
      try {
        const data = await request()
        const value = { data, fetchedAt: now(), isStale: false }
        cache.set(key, value)
        return value
      } catch (error) {
        const data = existing?.data ?? await fallback?.()
        if (!data || (Array.isArray(data) && !data.length)) throw error
        const value = { data, fetchedAt: now(), isStale: true }
        cache.set(key, value)
        return value
      } finally { pending.delete(key) }
    })()
    pending.set(key, task)
    return task
  }
  async function fetchQuotes() {
    const value = await cachedRequest('quotes', QUOTE_TTL, async () => {
      const text = await getText('https://hq.sinajs.cn/list=rt_hk00005,rt_hk02888', 'gb18030')
      const quotes = parseHkStockQuotes(text)
      if (quotes.size !== Object.keys(HK_STOCKS_INSTRUMENTS).length) throw new Error('港股快照数据不完整')
      return quotes
    })
    return new Map([...value.data].map(([key, quote]) => [key, { ...quote, isStale: value.isStale }]))
  }
  async function history(symbol) {
    let baseline
    const bundled = async () => {
      if (cache.get(`daily:${symbol}`)?.data) return cache.get(`daily:${symbol}`).data
      if (!baseline) baseline = parseHkDailyRows((await loadHistory(symbol)).rows)
      if (!baseline.length) throw new Error('港股历史缓存为空')
      return baseline
    }
    return cachedRequest(`daily:${symbol}`, HISTORY_TTL, async () => {
      const [base, raw] = await Promise.all([bundled(), getText(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=hk${symbol},day,,,1000,`)])
      const payload = JSON.parse(raw)
      if (payload.code !== 0) throw new Error('港股日线服务返回错误')
      const latest = parseHkDailyRows(payload.data?.[`hk${symbol}`]?.day)
      if (!latest.length) throw new Error('港股日线数据为空')
      // The bundled series was paged backwards to the source's first record;
      // replacing just the recent window must never truncate MAX to 1,000 bars.
      return uniqueSorted([...base, ...latest])
    }, bundled)
  }
  async function minuteHistory(symbol) {
    return cachedRequest(`minutes:${symbol}`, QUOTE_TTL, async () => {
      const payload = JSON.parse(await getText(`https://web.ifzq.gtimg.cn/appstock/app/day/query?code=hk${symbol}`))
      if (payload.code !== 0) throw new Error('港股分时服务返回错误')
      const points = parseHkMinuteSessions(payload.data?.[`hk${symbol}`]?.data)
      if (!points.length) throw new Error('港股分时数据为空')
      return points
    })
  }
  async function fetchTrend(key, period = 'MAX') {
    const instrument = HK_STOCKS_INSTRUMENTS[key]
    if (!instrument || !PERIODS.has(period)) throw new Error('未知港股代码或周期')
    const intraday = period === '1D' || period === '5D'
    const [dailyResult, quoteResult, minuteResult] = await Promise.allSettled([
      history(instrument.sourceSymbol), fetchQuotes(), intraday ? minuteHistory(instrument.sourceSymbol) : Promise.resolve(null),
    ])
    if (dailyResult.status === 'rejected') throw dailyResult.reason
    const daily = dailyResult.value
    const quote = quoteResult.status === 'fulfilled' ? quoteResult.value.get(key) : null
    const minutes = minuteResult.status === 'fulfilled' ? minuteResult.value : null
    const source = minutes?.data ?? daily.data
    const points = slicePeriod(source, period, Boolean(minutes))
    if (!points.length) throw new Error('港股趋势数据为空')
    const latestDay = daily.data.at(-1)
    const previousClose = quote?.previousClose ?? daily.data.at(-2)?.close ?? null
    const price = quote?.price ?? latestDay.close
    const change = previousClose === null ? null : price - previousClose
    const isStale = daily.isStale || !quote || quote.isStale || Boolean(intraday && (!minutes || minutes.isStale))
    const notes = ['港股普通股；日线为腾讯不复权价格，分红、拆股等会影响跨期比较。', '历史显示数据源全部可用记录，不代表公司创立以来。']
    if (intraday && !minutes) notes.push('分时源暂不可用，显示最近交易日的真实日线。')
    if (isStale) notes.push('部分上游刷新失败，保留最近可用数据及原始时间。')
    return {
      ...instrument, price, previousClose, change, changePercent: previousClose === null ? null : change / previousClose * 100,
      dayHigh: quote?.dayHigh ?? latestDay.high, dayLow: quote?.dayLow ?? latestDay.low,
      marketTime: quote?.marketTime ?? latestDay.time, dataGranularity: minutes ? '1m' : '1d',
      historyStart: daily.data[0].time, historyEnd: daily.data.at(-1).time,
      sourceName: '新浪财经报价 / 腾讯财经历史', sourceUrl: `https://gu.qq.com/hk${instrument.sourceSymbol}/gp`,
      dataNote: notes.join(' '), isStale, points,
    }
  }
  return { fetchQuotes, fetchTrend }
}

const adapter = createHkStocksAdapter()
export const fetchHkStockQuotes = adapter.fetchQuotes
export const fetchHkStockTrend = adapter.fetchTrend
