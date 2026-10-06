// 新浪美股快照与历史数据适配器。
// 本模块保持独立，server.mjs 可以在需要时按需 import。

const CACHE_TTL = 12_000
const HISTORY_CACHE_TTL = 5 * 60_000
const REQUEST_TIMEOUT = 8_000

export const US_INSTRUMENTS = {
  BRKB: {
    symbol: 'BRK.B',
    sourceSymbol: 'BRK.B',
    snapshotSymbol: 'brk$b',
    name: '伯克希尔哈撒韦B',
    englishName: 'Berkshire Hathaway B',
    contract: 'Berkshire Hathaway Class B',
    kind: 'stock',
    unit: 'USD/股',
    currency: 'USD',
    exchange: 'NYSE',
  },
  GOOGL: {
    symbol: 'GOOGL',
    sourceSymbol: 'GOOGL',
    snapshotSymbol: 'googl',
    name: '谷歌A类股',
    englishName: 'Alphabet Class A',
    contract: 'Alphabet Class A',
    kind: 'stock',
    unit: 'USD/股',
    currency: 'USD',
    exchange: 'NASDAQ',
  },
  SPCX: {
    symbol: 'SPCX',
    sourceSymbol: 'SPCX',
    snapshotSymbol: 'spcx',
    name: 'SpaceX',
    englishName: 'SpaceX Class A',
    contract: 'SpaceX Class A',
    kind: 'stock',
    unit: 'USD/股',
    currency: 'USD',
    exchange: 'NASDAQ',
  },
  KO: {
    symbol: 'KO',
    sourceSymbol: 'KO',
    snapshotSymbol: 'ko',
    name: '可口可乐',
    englishName: 'The Coca-Cola Company',
    contract: 'The Coca-Cola Company',
    kind: 'stock',
    unit: 'USD/股',
    currency: 'USD',
    exchange: 'NYSE',
    exchangeTimezone: 'America/New_York',
  },
  MCD: {
    symbol: 'MCD',
    sourceSymbol: 'MCD',
    snapshotSymbol: 'mcd',
    name: '麦当劳',
    englishName: "McDonald's Corporation",
    contract: "McDonald's Corporation",
    kind: 'stock',
    unit: 'USD/股',
    currency: 'USD',
    exchange: 'NYSE',
    exchangeTimezone: 'America/New_York',
  },
  NDX: {
    symbol: '^NDX',
    sourceSymbol: '.NDX',
    snapshotSymbol: 'ndx',
    name: '纳斯达克100指数',
    englishName: 'Nasdaq-100 Index',
    contract: 'Nasdaq-100 Index',
    kind: 'index',
    unit: '点',
    currency: 'USD',
    exchange: 'NASDAQ',
  },
  SPX: {
    symbol: '^GSPC',
    sourceSymbol: '.INX',
    snapshotSymbol: 'inx',
    name: '标普500指数',
    englishName: 'S&P 500 Index',
    contract: 'S&P 500 Index',
    kind: 'index',
    unit: '点',
    currency: 'USD',
    exchange: 'CBOE',
  },
  DJI: {
    symbol: '^DJI',
    sourceSymbol: '.DJI',
    snapshotSymbol: 'dji',
    name: '道琼斯指数',
    englishName: 'Dow Jones Industrial Average',
    contract: 'Dow Jones Industrial Average',
    kind: 'index',
    unit: '点',
    currency: 'USD',
    exchange: 'DJI',
  },
}

const quoteCache = { time: 0, data: new Map() }
const trendCache = new Map()

function finite(value) {
  return Number.isFinite(value) ? value : null
}

function number(value) {
  if (value === undefined || value === null || value === '' || value === '--') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function parseJsonp(text) {
  const start = text.indexOf('=(')
  const end = text.lastIndexOf(');')
  if (start < 0 || end < 0) throw new Error('新浪美股数据格式异常')
  const value = JSON.parse(text.slice(start + 2, end))
  if (!value) throw new Error('新浪美股数据为空')
  return value
}

async function getText(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Referer: 'https://finance.sina.com.cn/',
        'User-Agent': 'Mozilla/5.0 Market Dashboard',
      },
    })
    if (!response.ok) throw new Error(`新浪美股服务返回 ${response.status}`)
    return await response.text()
  } finally {
    clearTimeout(timer)
  }
}

function parseEtDate(value) {
  if (!value) return null
  const text = String(value).trim()
  // Sina 的日线日期没有时区；正午时间可以避免夏令时切换造成日期漂移。
  const iso = text.includes(' ') ? text.replace(' ', 'T') : `${text}T12:00:00`
  const timestamp = Date.parse(`${iso}-04:00`)
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null
}

function parseEtClock(value, reference = new Date()) {
  if (!value) return null
  const text = String(value).trim()
  const match = text.match(/^(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})(AM|PM)\s+EDT$/i)
  if (!match) return null
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(match[1])
  if (month < 0) return null
  let hour = Number(match[3])
  if (match[5].toUpperCase() === 'PM' && hour !== 12) hour += 12
  if (match[5].toUpperCase() === 'AM' && hour === 12) hour = 0
  const year = reference.getUTCFullYear()
  const timestamp = Date.parse(`${year}-${String(month + 1).padStart(2, '0')}-${String(match[2]).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${match[4]}:00-04:00`)
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null
}

function parseSnapshot(key, values) {
  const instrument = US_INSTRUMENTS[key]
  const regularPrice = number(values[1])
  const regularChange = number(values[4])
  const regularChangePercent = number(values[2])
  const previousClose = number(values[26])
  const regularTime = parseEtDate(values[3])
  const quotedExtendedPrice = number(values[21])
  // 新浪对现金指数没有盘后报价时会返回 0 和一个旧的时间字符串。
  // 暴露为 null，调用方即可安全地判断是否存在可用盘后价。
  const extendedPrice = quotedExtendedPrice !== null && quotedExtendedPrice > 0 ? quotedExtendedPrice : null
  const extendedChange = extendedPrice === null ? null : number(values[23])
  const extendedChangePercent = extendedPrice === null ? null : number(values[22])
  const extendedTime = extendedPrice === null ? null : parseEtClock(values[24])
  return {
    key,
    symbol: instrument.symbol,
    regularPrice,
    regularChange,
    regularChangePercent,
    regularMarketTime: regularTime,
    extendedPrice,
    extendedChange,
    extendedChangePercent,
    extendedMarketTime: extendedTime,
    // Aliases make the object usable by both quote cards and the session switcher.
    price: regularPrice,
    previousClose,
    change: regularChange,
    changePercent: regularChangePercent,
    dayHigh: number(values[6]),
    dayLow: number(values[7]),
    open: number(values[5]),
    volume: number(values[10]),
    marketTime: regularTime,
    exchangeTimezone: 'America/New_York',
    currency: instrument.currency,
    exchange: instrument.exchange,
  }
}

/** Fetch regular and extended quotes for the configured stocks and cash indices. */
export async function fetchUsQuotes() {
  if (Date.now() - quoteCache.time < CACHE_TTL && quoteCache.data.size) return quoteCache.data
  const symbols = Object.values(US_INSTRUMENTS).map((instrument) => `gb_${instrument.snapshotSymbol}`).join(',')
  const text = await getText(`https://hq.sinajs.cn/list=${symbols}`)
  const quotes = new Map()
  const sourceToKey = Object.fromEntries(Object.entries(US_INSTRUMENTS).map(([key, value]) => [value.snapshotSymbol, key]))
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^var hq_str_gb_([^=]+)="(.*)";$/)
    if (!match) continue
    const key = sourceToKey[match[1]]
    if (!key) continue
    const values = match[2].split(',')
    if (!values.length || !values[1]) continue
    quotes.set(key, parseSnapshot(key, values))
  }
  if (!quotes.size) throw new Error('新浪美股快照为空')
  quoteCache.time = Date.now()
  quoteCache.data = quotes
  return quotes
}

function makePoints(key, rows, period) {
  const isIntraday = period === '1D' || period === '5D'
  const points = rows.map((row) => {
    const time = parseEtDate(row.d)
    return {
      time,
      open: number(row.o),
      high: number(row.h),
      low: number(row.l),
      close: number(row.c),
      volume: number(row.v),
    }
  }).filter((point) => Number.isFinite(point.time) && point.close !== null)
  if (!points.length) throw new Error(`${key} 美股历史数据为空`)
  if (period === '1D') {
    const latestDay = points.at(-1)?.time
    const latestDate = latestDay ? new Date(latestDay * 1000).toISOString().slice(0, 10) : ''
    return points.filter((point) => new Date(point.time * 1000).toISOString().slice(0, 10) === latestDate)
  }
  if (!isIntraday) {
    const days = { '1M': 32, '3M': 95, '1Y': 370, '5Y': 1900 }[period]
    if (days) {
      const cutoff = points.at(-1).time - days * 86_400
      return points.filter((point) => point.time >= cutoff)
    }
  }
  return points
}

/** Fetch daily or intraday history. Sina returns unadjusted prices; historyStart is the real feed start. */
export async function fetchUsTrend(key, period = '1D') {
  const instrument = US_INSTRUMENTS[key]
  if (!instrument) throw new Error(`未知美股代码 ${key}`)
  const cacheKey = `${key}:${period}`
  const cached = trendCache.get(cacheKey)
  if (cached && Date.now() - cached.time < (period === 'MAX' ? HISTORY_CACHE_TTL : CACHE_TTL)) return cached.data
  const isIntraday = period === '1D' || period === '5D'
  const method = isIntraday ? 'getMinK' : 'getDailyK'
  const query = isIntraday ? `&type=1` : ''
  const url = `https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var%20_data=/US_MinKService.${method}?symbol=${encodeURIComponent(instrument.sourceSymbol)}${query}`
  const rows = parseJsonp(await getText(url))
  const points = makePoints(key, rows, period)
  const last = points.at(-1)
  const previousClose = points.at(-2)?.close ?? null
  const change = previousClose === null ? null : last.close - previousClose
  const closes = points.map((point) => point.close)
  const data = {
    key,
    symbol: instrument.symbol,
    name: instrument.name,
    englishName: instrument.englishName,
    contract: instrument.contract,
    kind: instrument.kind,
    unit: instrument.unit,
    currency: instrument.currency,
    exchange: instrument.exchange,
    price: last.close,
    previousClose,
    change,
    changePercent: change !== null && previousClose ? (change / previousClose) * 100 : null,
    dayHigh: Math.max(...closes),
    dayLow: Math.min(...closes),
    marketTime: last.time,
    exchangeTimezone: 'America/New_York',
    dataGranularity: isIntraday ? '1m' : '1d',
    historyStart: points[0].time,
    historyEnd: last.time,
    points,
  }
  trendCache.set(cacheKey, { time: Date.now(), data })
  return data
}
