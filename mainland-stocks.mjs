const TIMEOUT = 8_000
const QUOTE_TTL = 12_000
const HISTORY_TTL = 5 * 60_000
const PERIODS = new Set(['1D', '5D', '1M', '3M', '1Y', '5Y', 'MAX'])

export const MAINLAND_STOCKS_INSTRUMENTS = {
  UNITREE: {
    key: 'UNITREE', symbol: '688836.SH', sourceSymbol: 'sh688836', name: '宇树科技', englishName: 'Unitree Robotics',
    kind: 'stock', unit: 'CNY/股', currency: 'CNY', exchange: '上交所科创板', exchangeTimezone: 'Asia/Shanghai',
    precision: 2, watchStance: 'bearish', contract: '宇树科技科创板普通股', listingDate: '2026-08-19',
  },
  VANKE: {
    key: 'VANKE', symbol: '000002.SZ', sourceSymbol: 'sz000002', name: '万科A', englishName: 'China Vanke A',
    kind: 'stock', unit: 'CNY/股', currency: 'CNY', exchange: '深交所', exchangeTimezone: 'Asia/Shanghai',
    precision: 2, watchStance: 'bearish', contract: '万科深交所A股普通股', listingDate: '1991-01-29',
  },
}

function numeric(value, positive = false) {
  if (value === null || value === undefined || String(value).trim() === '') return null
  const number = Number(value)
  return Number.isFinite(number) && (!positive || number > 0) ? number : null
}

function timestamp(rawDate, clock = null) {
  let day = String(rawDate ?? '').replaceAll('/', '-')
  if (/^\d{8}$/.test(day)) day = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || (clock !== null && !/^\d{2}:\d{2}:\d{2}$/.test(clock))) return null
  // Daily bars are dates at UTC midnight; actual trade times use Shanghai's UTC+8.
  const milliseconds = Date.parse(`${day}T${clock ?? '00:00:00'}${clock === null ? 'Z' : '+08:00'}`)
  if (!Number.isFinite(milliseconds)) return null
  const local = new Date(milliseconds + (clock === null ? 0 : 8 * 3600_000)).toISOString()
  if (local.slice(0, 10) !== day || (clock !== null && local.slice(11, 19) !== clock)) return null
  return milliseconds / 1000
}

function sortedUnique(points) {
  return [...new Map(points.map((point) => [point.time, point])).values()].sort((a, b) => a.time - b.time)
}

function validName(value, instrument) {
  const normalize = (name) => name.normalize('NFKC').replace(/\s+/g, '').replace(/-W$/, '')
  return typeof value === 'string' && normalize(value) === normalize(instrument.name)
}

function instrumentPayload(payload, instrument) {
  const data = payload?.data?.[instrument.sourceSymbol]
  const quote = data?.qt?.[instrument.sourceSymbol]
  if (payload?.code !== 0 || !data || !Array.isArray(quote) || quote[2] !== instrument.symbol.slice(0, 6) || !validName(quote[1], instrument)) {
    throw new Error('A 股数据源证券身份校验失败')
  }
  return data
}

/** Tencent unadjusted rows: date, open, close, high, low, volume. */
export function parseMainlandDailyRows(rows, listingDate = '1900-01-01') {
  if (!Array.isArray(rows)) throw new Error('A 股日线格式异常')
  const firstTime = timestamp(listingDate)
  return sortedUnique(rows.flatMap((row) => {
    if (!Array.isArray(row)) return []
    const time = timestamp(row[0])
    const open = numeric(row[1], true)
    const close = numeric(row[2], true)
    const high = numeric(row[3], true)
    const low = numeric(row[4], true)
    const volume = numeric(row[5])
    if (time === null || time < firstTime || close === null || (high !== null && high < Math.max(open ?? close, close)) || (low !== null && low > Math.min(open ?? close, close))) return []
    return [{ time, open, close, high, low, volume: volume !== null && volume >= 0 ? volume : null }]
  }))
}

export function parseMainlandMinuteSessions(sessions, listingDate = '1900-01-01') {
  if (!Array.isArray(sessions)) throw new Error('A 股分时格式异常')
  const result = []
  const firstTime = timestamp(listingDate, '00:00:00')
  for (const session of sessions) {
    const rows = new Map()
    for (const line of Array.isArray(session?.data) ? session.data : []) {
      if (typeof line !== 'string') continue
      const [clock, rawClose, rawVolume] = line.trim().split(/\s+/)
      if (!/^\d{4}$/.test(clock)) continue
      const time = timestamp(session.date, `${clock.slice(0, 2)}:${clock.slice(2)}:00`)
      const close = numeric(rawClose, true)
      if (time === null || time < firstTime || close === null) continue
      rows.set(time, { time, close, cumulativeVolume: numeric(rawVolume) })
    }
    let previousVolume = 0
    for (const row of [...rows.values()].sort((a, b) => a.time - b.time)) {
      const volume = row.cumulativeVolume !== null && row.cumulativeVolume >= previousVolume ? row.cumulativeVolume - previousVolume : null
      if (row.cumulativeVolume !== null && row.cumulativeVolume >= previousVolume) previousVolume = row.cumulativeVolume
      result.push({ time: row.time, open: null, close: row.close, high: null, low: null, volume })
    }
  }
  return sortedUnique(result)
}

export function parseMainlandStockQuote(text, instrument = MAINLAND_STOCKS_INSTRUMENTS.UNITREE) {
  const match = String(text).match(new RegExp(`hq_str_${instrument.sourceSymbol}="([^"]*)"`))
  const fields = match?.[1].split(',')
  if (!fields || !validName(fields[0], instrument)) throw new Error('A 股报价证券身份校验失败')
  const price = numeric(fields[3], true)
  const marketTime = timestamp(fields[30], fields[31])
  if (price === null || marketTime === null || marketTime < timestamp(instrument.listingDate, '00:00:00')) throw new Error('A 股报价或原始时间缺失')
  const previousClose = numeric(fields[2], true)
  return {
    price, previousClose, marketTime, open: numeric(fields[1], true),
    dayHigh: numeric(fields[4], true), dayLow: numeric(fields[5], true), volume: numeric(fields[8]),
  }
}

function slicePeriod(points, period, intraday = false) {
  if (period === '1D' || period === '5D') {
    const dayOf = (point) => new Date(point.time * 1000 + (intraday ? 8 * 3600_000 : 0)).toISOString().slice(0, 10)
    const days = [...new Set(points.map(dayOf))]
    const first = days.at(period === '1D' ? -1 : -5) ?? days[0]
    return points.filter((point) => dayOf(point) >= first)
  }
  const days = { '1M': 32, '3M': 95, '1Y': 370, '5Y': 1900 }[period]
  return days ? points.filter((point) => point.time >= points.at(-1).time - days * 86400) : points
}

export function createMainlandStocksAdapter({ fetchImpl = fetch, now = Date.now } = {}) {
  const cache = new Map()
  const pending = new Map()
  async function getText(url, encoding = 'utf-8') {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT), headers: { Referer: 'https://finance.sina.com.cn/', 'User-Agent': 'Mozilla/5.0 Market Dashboard' } })
    if (!response.ok) throw new Error(`A 股数据服务返回 ${response.status}`)
    return new TextDecoder(encoding).decode(await response.arrayBuffer())
  }
  async function cached(key, ttl, request) {
    const previous = cache.get(key)
    if (previous && now() - previous.fetchedAt < ttl) return previous
    if (pending.has(key)) return pending.get(key)
    const task = (async () => {
      try {
        const data = await request(previous?.data)
        const value = { data, fetchedAt: now(), isStale: false }
        cache.set(key, value)
        return value
      } catch (error) {
        if (!previous) throw error
        const value = { ...previous, fetchedAt: now(), isStale: true }
        cache.set(key, value)
        return value
      } finally { pending.delete(key) }
    })()
    pending.set(key, task)
    return task
  }
  function quote(instrument) {
    return cached(`quote:${instrument.key}`, QUOTE_TTL, async () => parseMainlandStockQuote(await getText(`https://hq.sinajs.cn/list=${instrument.sourceSymbol}`, 'gb18030'), instrument))
  }
  function history(instrument) {
    return cached(`daily:${instrument.key}`, HISTORY_TTL, async (previous) => {
      let end = ''
      let points = previous ?? []
      let previousFirst = Infinity
      // Page backward when a company eventually exceeds the source's 1,000-bar window.
      for (let page = 0; page < 100; page += 1) {
        const payload = JSON.parse(await getText(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${instrument.sourceSymbol},day,,${end},1000,`))
        const rows = parseMainlandDailyRows(instrumentPayload(payload, instrument).day, instrument.listingDate)
        if (!rows.length || rows[0].time >= previousFirst) throw new Error('A 股历史分页未取得更早记录')
        previousFirst = rows[0].time
        points = sortedUnique([...points, ...rows])
        const listingTime = timestamp(instrument.listingDate)
        const overlapsCompleteCache = previous?.[0]?.time === listingTime && rows[0].time <= previous.at(-1).time
        if (rows[0].time === listingTime || overlapsCompleteCache) return points
        end = new Date((rows[0].time - 86400) * 1000).toISOString().slice(0, 10)
      }
      throw new Error('A 股历史未覆盖上市首日')
    })
  }
  function minuteHistory(instrument) {
    return cached(`minutes:${instrument.key}`, QUOTE_TTL, async () => {
      const payload = JSON.parse(await getText(`https://web.ifzq.gtimg.cn/appstock/app/day/query?code=${instrument.sourceSymbol}`))
      const points = parseMainlandMinuteSessions(instrumentPayload(payload, instrument).data, instrument.listingDate)
      if (!points.length) throw new Error('A 股分时数据为空')
      return points
    })
  }
  async function fetchTrend(key, period = 'MAX') {
    const instrument = MAINLAND_STOCKS_INSTRUMENTS[key]
    if (!instrument || !PERIODS.has(period)) throw new Error('未知 A 股代码或周期')
    const intraday = period === '1D' || period === '5D'
    const [dailyResult, quoteResult, minuteResult] = await Promise.allSettled([
      history(instrument), quote(instrument), intraday ? minuteHistory(instrument) : Promise.resolve(null),
    ])
    if (dailyResult.status === 'rejected') throw dailyResult.reason
    const daily = dailyResult.value
    const snapshot = quoteResult.status === 'fulfilled' ? quoteResult.value : null
    const minutes = minuteResult.status === 'fulfilled' ? minuteResult.value : null
    const latestDay = daily.data.at(-1)
    const previousClose = snapshot?.data.previousClose ?? daily.data.at(-2)?.close ?? null
    const price = snapshot?.data.price ?? latestDay.close
    const change = previousClose === null ? null : price - previousClose
    const isStale = daily.isStale || !snapshot || snapshot.isStale || Boolean(intraday && (!minutes || minutes.isStale))
    const notes = [`${instrument.contract}；历史自 ${instrument.listingDate} 上市首日起。日线为不复权价格，分红、拆股会影响跨期比较。`, '休市期间保留最近交易日行情，报价时间以来源为准。']
    if (intraday && !minutes) notes.push('分时源暂不可用，显示最近交易日的真实日线。')
    if (isStale) notes.push('部分上游刷新失败，保留最近可用数据及原始时间。')
    return {
      ...instrument, price, previousClose, change, changePercent: change === null ? null : change / previousClose * 100,
      dayHigh: snapshot?.data.dayHigh ?? latestDay.high, dayLow: snapshot?.data.dayLow ?? latestDay.low,
      marketTime: snapshot?.data.marketTime ?? latestDay.time, dataGranularity: minutes ? '1m' : '1d',
      historyStart: daily.data[0].time, historyEnd: latestDay.time,
      sourceName: '新浪财经报价 / 腾讯财经历史', sourceUrl: `https://gu.qq.com/${instrument.sourceSymbol}/gp`,
      dataNote: notes.join(' '), isStale, points: slicePeriod(minutes?.data ?? daily.data, period, Boolean(minutes)),
    }
  }
  return { fetchTrend }
}

const adapter = createMainlandStocksAdapter()
export const fetchMainlandStockTrend = adapter.fetchTrend
