const TIMEOUT = 8_000
const QUOTE_TTL = 12_000
const HISTORY_TTL = 5 * 60_000
const PERIODS = new Set(['1D', '5D', '1M', '3M', '1Y', '5Y', 'MAX'])
const FACTSHEET_ROOT = 'https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/indices/detail/files/zh_CN/'

export const DIVIDEND_INDEX_INSTRUMENTS = Object.fromEntries([
  ['CSI_DIV', '000922', '中证红利指数', 'CSI Dividend Index', '1.000922', '中证红利', '2004-12-31', '2008-05-26'],
  ['CSI_DIV_LV', 'H30269', '中证红利低波动指数', 'CSI Dividend Low Volatility Index', '2.H30269', '红利低波', '2005-12-30', '2013-12-19'],
  ['CSI_DIV_LV100', '930955', '中证红利低波动100指数', 'CSI Dividend Low Volatility 100 Index', '2.930955', '红利低波100', '2005-12-30', '2017-05-26'],
  ['SSE_DIV', '000015', '上证红利指数', 'SSE Dividend Index', '1.000015', '红利指数', '2004-12-31', '2005-01-04'],
].map(([key, symbol, name, englishName, secid, sourceName, baseDate, launchDate]) => [key, {
  key, symbol, name, englishName, secid, providerName: sourceName, baseDate, launchDate,
  kind: 'index', unit: '点', currency: 'CNY', exchange: key === 'SSE_DIV' ? '上交所 / 中证指数' : '中证指数',
  exchangeTimezone: 'Asia/Shanghai', precision: 2, contract: `${name}（价格指数）`,
  sourceUrl: `${FACTSHEET_ROOT}${symbol}factsheet.pdf`,
}]))

function positive(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function timestamp(value) {
  let text = String(value ?? '')
  if (/^\d{8}$/.test(text)) text = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}`
  const daily = /^\d{4}-\d{2}-\d{2}$/.test(text)
  if (!daily && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(text)) return null
  const iso = daily ? `${text}T00:00:00Z` : `${text.replace(' ', 'T')}:00+08:00`
  const milliseconds = Date.parse(iso)
  if (!Number.isFinite(milliseconds)) return null
  const roundTrip = new Date(milliseconds + (daily ? 0 : 8 * 3600_000)).toISOString()
  if (roundTrip.slice(0, daily ? 10 : 16) !== text.replace(' ', 'T')) return null
  return milliseconds / 1000
}

function sortedUnique(points) {
  return [...new Map(points.map((point) => [point.time, point])).values()].sort((a, b) => a.time - b.time)
}

function point(date, closeValue, openValue, highValue, lowValue, instrument) {
  const time = timestamp(date)
  const close = positive(closeValue)
  if (time === null || close === null || time < timestamp(instrument.baseDate)) return null
  const historical = time < timestamp(instrument.launchDate)
  const open = historical ? null : positive(openValue)
  const high = historical ? null : positive(highValue)
  const low = historical ? null : positive(lowValue)
  if (high !== null && high < Math.max(open ?? close, close)) return null
  if (low !== null && low > Math.min(open ?? close, close)) return null
  if (high !== null && low !== null && high < low) return null
  // Index levels have no directly traded volume. The providers' constituent
  // volume units differ, so do not mix shares and lots in one history series.
  return { time, open, close, high, low, volume: null }
}

export function parseCsiDividendDaily(payload, instrument) {
  if (String(payload?.code) !== '200' || payload?.success !== true || !Array.isArray(payload.data)) throw new Error('中证指数日线格式异常')
  if (payload.data.some((row) => row?.indexCode !== instrument.symbol)) throw new Error('中证指数日线代码不匹配')
  const points = sortedUnique(payload.data.filter((row) => /^\d{8}$/.test(row.tradeDate)).map((row) => point(row.tradeDate, row.close, row.open, row.high, row.low, instrument)).filter(Boolean))
  if (!points.length) throw new Error('中证指数日线为空')
  const baseTime = timestamp(instrument.baseDate)
  // The official performance API can copy the next observation onto its start
  // boundary. All four official factsheets define the base level as 1,000.
  // Replace that boundary only when present; never bridge missing history.
  if (points[0].time === baseTime) points[0] = { time: baseTime, open: null, close: 1000, high: null, low: null, volume: null }
  return points
}

function eastmoneyPayload(payload, instrument, field) {
  const data = payload?.data
  if (payload?.rc !== 0 || data?.code !== instrument.symbol || data?.name !== instrument.providerName || Number(data?.market) !== Number(instrument.secid.split('.')[0]) || !Array.isArray(data[field])) throw new Error('东方财富红利指数身份或格式异常')
  return data
}

export function parseDividendDaily(payload, instrument) {
  const data = eastmoneyPayload(payload, instrument, 'klines')
  const points = sortedUnique(data.klines.filter((row) => typeof row === 'string').map((row) => {
    const [date, open, close, high, low] = row.split(',')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
    return point(date, close, open, high, low, instrument)
  }).filter(Boolean))
  if (!points.length) throw new Error('东方财富红利指数日线为空')
  return points
}

export function parseDividendMinutes(payload, instrument) {
  const data = eastmoneyPayload(payload, instrument, 'trends')
  const points = sortedUnique(data.trends.filter((row) => typeof row === 'string').map((row) => {
    const [date, open, close, high, low] = row.split(',')
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(date)) return null
    return point(date, close, open, high, low, instrument)
  }).filter(Boolean))
  if (!points.length) throw new Error('东方财富红利指数分时为空')
  // Use the timestamp and close from the same minute observation. The separate
  // quotation endpoint returns f124=0 for these indices, so cannot supply a clock.
  return { points, previousClose: positive(data.preClose) }
}

function dayOf(time, intraday = false) {
  return new Date((time + (intraday ? 8 * 3600 : 0)) * 1000).toISOString().slice(0, 10)
}

export function selectDividendPoints(points, period, intraday = false) {
  if (!PERIODS.has(period)) throw new Error('未知红利指数周期')
  if (!points.length) return []
  if (period === '1D' || period === '5D') {
    const days = [...new Set(points.map((row) => dayOf(row.time, intraday)))]
    const first = days.at(period === '1D' ? -1 : -5) ?? days[0]
    return points.filter((row) => dayOf(row.time, intraday) >= first)
  }
  const days = { '1M': 32, '3M': 95, '1Y': 370, '5Y': 1900 }[period]
  return days ? points.filter((row) => row.time >= points.at(-1).time - days * 86400) : points
}

export function createDividendIndicesAdapter({ fetchImpl = fetch, now = Date.now } = {}) {
  const cache = new Map()
  const pending = new Map()
  async function getJson(url) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT), headers: { Referer: url.includes('csindex.com.cn') ? 'https://www.csindex.com.cn/' : 'https://quote.eastmoney.com/', 'User-Agent': 'Mozilla/5.0 Market Dashboard' } })
    if (!response.ok) throw new Error(`红利指数数据服务返回 ${response.status}`)
    return response.json()
  }
  async function cached(key, ttl, load) {
    const previous = cache.get(key)
    if (previous && now() - previous.fetchedAt < ttl) return previous
    if (pending.has(key)) return pending.get(key)
    const request = (async () => {
      try {
        const data = await load(previous?.data)
        const value = { data, fetchedAt: now(), isStale: Boolean(data.partialRefresh) }
        cache.set(key, value)
        return value
      } catch (error) {
        if (!previous) throw error
        const value = { ...previous, fetchedAt: now(), isStale: true }
        cache.set(key, value)
        return value
      } finally { pending.delete(key) }
    })()
    pending.set(key, request)
    return request
  }
  function daily(instrument) {
    return cached(`daily:${instrument.key}`, HISTORY_TTL, async (previous) => {
      const endDate = dayOf(now() / 1000, true).replaceAll('-', '')
      const [official, recent] = await Promise.allSettled([
        getJson(`https://www.csindex.com.cn/csindex-home/perf/index-perf?indexCode=${instrument.symbol}&startDate=${instrument.baseDate.replaceAll('-', '')}&endDate=${endDate}`).then((data) => parseCsiDividendDaily(data, instrument)),
        getJson(`https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${instrument.secid}&klt=101&fqt=0&beg=0&end=20500101&lmt=10000&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56`).then((data) => parseDividendDaily(data, instrument)),
      ])
      if (official.status === 'rejected' && recent.status === 'rejected') throw official.reason
      // Preserve the full already-loaded past if an upstream response later
      // shrinks to a short window; current provider bars win on overlapping dates.
      const points = sortedUnique([...(previous?.points ?? []), ...(official.status === 'fulfilled' ? official.value : []), ...(recent.status === 'fulfilled' ? recent.value : [])])
      return { points, partialRefresh: official.status === 'rejected' || recent.status === 'rejected' }
    })
  }
  function minutes(instrument) {
    return cached(`minutes:${instrument.key}`, QUOTE_TTL, async () => parseDividendMinutes(await getJson(`https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${instrument.secid}&ndays=5&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57`), instrument))
  }
  async function fetchTrend(key, period = 'MAX') {
    const instrument = DIVIDEND_INDEX_INSTRUMENTS[key]
    if (!instrument || !PERIODS.has(period)) throw new Error('未知红利指数代码或周期')
    const [dailyResult, minuteResult] = await Promise.allSettled([daily(instrument), minutes(instrument)])
    if (dailyResult.status === 'rejected') throw dailyResult.reason
    const history = dailyResult.value
    const dailyPoints = history.data.points
    const lastDay = dailyPoints.at(-1)
    const minuteCache = minuteResult.status === 'fulfilled' ? minuteResult.value : null
    const minutePoints = minuteCache?.data.points
    const latestMinute = minutePoints?.at(-1)
    const usableMinutes = latestMinute && dayOf(latestMinute.time, true) >= dayOf(lastDay.time) ? minutePoints : null
    const intraday = period === '1D' || period === '5D'
    const latest = usableMinutes ? latestMinute : lastDay
    const today = usableMinutes ? minutePoints.filter((row) => dayOf(row.time, true) === dayOf(latest.time, true)) : null
    const previousClose = usableMinutes ? minuteCache.data.previousClose : dailyPoints.at(-2)?.close ?? null
    const change = previousClose === null ? null : latest.close - previousClose
    const isStale = history.isStale || !usableMinutes || Boolean(minuteCache?.isStale)
    const notes = [
      `价格指数；基日 ${instrument.baseDate} 的 1000 点依据中证官方资料，${instrument.launchDate} 正式发布，发布前为回溯值。`,
      '历史默认展示完整范围；最近报价取来源最后一分钟的指数及同条时间，休市保留最近交易日。',
    ]
    if (dailyPoints[0].time > timestamp(instrument.baseDate)) notes.push(`官方早期历史暂不可用，当前可用历史从 ${dayOf(dailyPoints[0].time)} 开始。`)
    if (!usableMinutes) notes.push('分时源暂不可用，报价与走势图退回最近可用日线收盘值，时间仅为该交易日日期。')
    if (isStale) notes.push('部分上游刷新失败或滞后，保留最近可用数据及原始时间。')
    return {
      ...instrument, price: latest.close, previousClose, change, changePercent: change === null ? null : change / previousClose * 100,
      dayHigh: today ? Math.max(...today.map((row) => row.high ?? row.close)) : lastDay.high,
      dayLow: today ? Math.min(...today.map((row) => row.low ?? row.close)) : lastDay.low,
      marketTime: latest.time, dataGranularity: intraday && usableMinutes ? '1m' : '1d',
      historyStart: dailyPoints[0].time, historyEnd: lastDay.time,
      sourceName: '中证指数官方历史 / 东方财富分钟行情', dataNote: notes.join(' '), isStale,
      points: selectDividendPoints(intraday && usableMinutes ? usableMinutes : dailyPoints, period, Boolean(intraday && usableMinutes)),
    }
  }
  return { fetchTrend }
}

const adapter = createDividendIndicesAdapter()
export const fetchDividendIndexTrend = adapter.fetchTrend
