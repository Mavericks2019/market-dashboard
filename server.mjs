import express from 'express'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { US_INSTRUMENTS, fetchUsQuotes, fetchUsTrend } from './us-markets.mjs'
import { getUsCashSession } from './us-session.mjs'
import { CFETS_INSTRUMENT, fetchCfetsTrend } from './cfets-market.mjs'
import { CNY_INSTRUMENT, fetchCnyTrend } from './cny-market.mjs'
import { HK_STOCKS_INSTRUMENTS, fetchHkStockTrend } from './hk-stocks.mjs'
import { HSTECH_INSTRUMENT, fetchHstechTrend } from './hstech-market.mjs'
import { MAINLAND_INSTRUMENTS, MAINLAND_ETF_INSTRUMENTS, MAINLAND_STOCKS_INSTRUMENTS, fetchMainlandStockTrend } from './mainland-stocks.mjs'
import { DIVIDEND_INDEX_INSTRUMENTS, fetchDividendIndexTrend } from './dividend-indices.mjs'
import { fetchFundamentals } from './fundamentals.mjs'
import { fetchHousingData } from './housing-market.mjs'
import { FUND_LINK_INSTRUMENTS, fetchEtfTotalReturn, fetchFundNavTrend } from './etf-total-return.mjs'

const app = express()
const port = Number(process.env.PORT || 4174)
const root = path.dirname(fileURLToPath(import.meta.url))
const cache = new Map()
const CACHE_TTL = 12_000
let sinaCache = { time: 0, data: new Map() }
const globalHistoryCache = new Map()

const instruments = {
  NQ: { symbol: 'NQ=F', name: '纳斯达克100期货', englishName: 'Nasdaq-100 Futures', contract: 'E-mini Nasdaq-100', kind: 'futures', unit: '点' },
  NDX: US_INSTRUMENTS.NDX,
  IXIC: { symbol: '^IXIC', name: '纳斯达克综合指数', englishName: 'NASDAQ Composite', contract: 'NASDAQ Composite', kind: 'index', unit: '点' },
  ES: { symbol: 'ES=F', name: '标普500期货', englishName: 'S&P 500 Futures', contract: 'E-mini S&P 500', kind: 'futures', unit: '点' },
  SPX: US_INSTRUMENTS.SPX,
  YM: { symbol: 'YM=F', name: '道琼斯期货', englishName: 'Dow Jones Futures', contract: 'E-mini Dow', kind: 'futures', unit: '点' },
  DJI: US_INSTRUMENTS.DJI,
  XAU: { symbol: 'XAU/USD', name: '伦敦现货金', englishName: 'Spot Gold', contract: 'Spot Gold', kind: 'metal', unit: 'USD/oz' },
  CFETS: CFETS_INSTRUMENT,
  USDCNY: CNY_INSTRUMENT,
  BRKB: US_INSTRUMENTS.BRKB,
  GOOGL: US_INSTRUMENTS.GOOGL,
  NVDA: US_INSTRUMENTS.NVDA,
  AAPL: US_INSTRUMENTS.AAPL,
  SPCX: US_INSTRUMENTS.SPCX,
  KO: US_INSTRUMENTS.KO,
  MCD: US_INSTRUMENTS.MCD,
  PDD: US_INSTRUMENTS.PDD,
  HSBC: HK_STOCKS_INSTRUMENTS.HSBC,
  STAN: HK_STOCKS_INSTRUMENTS.STAN,
  TENCENT: HK_STOCKS_INSTRUMENTS.TENCENT,
  UNITREE: MAINLAND_STOCKS_INSTRUMENTS.UNITREE,
  VANKE: MAINLAND_STOCKS_INSTRUMENTS.VANKE,
  ...MAINLAND_ETF_INSTRUMENTS,
  ...FUND_LINK_INSTRUMENTS,
  HSTECH: HSTECH_INSTRUMENT,
  SSE: { symbol: '000001.SS', name: '上证指数', englishName: 'SSE Composite', contract: '上证综合指数', kind: 'index', unit: '点' },
  SZSE: { symbol: '399001.SZ', name: '深证成指', englishName: 'SZSE Component', contract: '深证成份指数', kind: 'index', unit: '点' },
  ChiNext: { symbol: '399006.SZ', name: '创业板指', englishName: 'ChiNext Index', contract: '创业板指数', kind: 'index', unit: '点' },
  ...DIVIDEND_INDEX_INSTRUMENTS,
  FTSE: { symbol: '^FTSE', name: '英国富时100', englishName: 'FTSE 100', contract: 'FTSE 100 Index', kind: 'index', unit: '点' },
  DAX: { symbol: '^GDAXI', name: '德国DAX', englishName: 'DAX', contract: 'DAX Index', kind: 'index', unit: '点' },
  KOSPI: { symbol: '^KS11', name: '韩国综合指数', englishName: 'KOSPI', contract: 'KOSPI Composite', kind: 'index', unit: '点' },
  NIKKEI: { symbol: '^N225', name: '日经225', englishName: 'Nikkei 225', contract: 'Nikkei 225 Index', kind: 'index', unit: '点' },
}

const ranges = {
  '1D': { interval: '1m', range: '1d' },
  '5D': { interval: '5m', range: '5d' },
  '1M': { interval: '30m', range: '1mo' },
  '3M': { interval: '1d', range: '3mo' },
  '1Y': { interval: '1d', range: '1y' },
  '5Y': { interval: '1wk', range: '5y' },
  MAX: { interval: '1mo', range: 'max' },
}

async function fetchSinaPayload(url) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8_000)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Referer: 'https://finance.sina.com.cn/',
        'User-Agent': 'Mozilla/5.0 Market Dashboard',
      },
    })
    if (!response.ok) throw new Error(`新浪趋势服务返回 ${response.status}`)
    const text = new TextDecoder('gb18030').decode(await response.arrayBuffer())
    const start = text.indexOf('=(')
    const end = text.lastIndexOf(');')
    if (start < 0 || end < 0) throw new Error('趋势数据格式异常')
    return JSON.parse(text.slice(start + 2, end))
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchSinaTrend(key, period) {
  const cacheKey = `sina-trend:${key}:${period}`
  const cached = cache.get(cacheKey)
  if (cached && Date.now() - cached.time < CACHE_TTL) return cached.data

  let rawPoints
  let granularity
  if (period === '1D') {
    const url = `https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_data=/GlobalFuturesService.getGlobalFuturesMinLine?symbol=${key}`
    const payload = await fetchSinaPayload(url)
    rawPoints = (payload.minLine_1d || []).map((row) => {
      const timestampText = row.at(-1)
      const time = Date.parse(`${timestampText.replace(' ', 'T')}+08:00`)
      const close = row.length > 6 ? row[5] : row[1]
      return { time: Math.floor(time / 1000), close: finite(Number(close)) }
    })
    granularity = '1m'
  } else {
    const url = `https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_data=/GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=${key}&source=web`
    const payload = await fetchSinaPayload(url)
    const calendarDays = period === '5D' ? 8 : period === '1M' ? 32 : period === '3M' ? 95 : period === '1Y' ? 370 : period === '5Y' ? 1900 : null
    const lastTime = Date.parse(`${payload.at(-1)?.date}T00:00:00+08:00`)
    const cutoff = calendarDays ? lastTime - calendarDays * 86_400_000 : 0
    rawPoints = payload
      .filter((row) => Date.parse(`${row.date}T00:00:00+08:00`) >= cutoff)
      .map((row) => ({
        time: Math.floor(Date.parse(`${row.date}T00:00:00+08:00`) / 1000),
        open: finite(Number(row.open)),
        high: finite(Number(row.high)),
        low: finite(Number(row.low)),
        close: finite(Number(row.close)),
        volume: finite(Number(row.volume)),
      }))
    granularity = '1d'
  }

  const points = rawPoints.filter((point) => Number.isFinite(point.time) && point.close !== null)
  if (!points.length) throw new Error('趋势数据为空')
  const instrument = instruments[key]
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
    currency: 'USD',
    exchange: key === 'XAU' ? 'LBMA' : 'CME',
    price: last.close,
    previousClose,
    change,
    changePercent: change !== null && previousClose ? (change / previousClose) * 100 : null,
    dayHigh: Math.max(...closes),
    dayLow: Math.min(...closes),
    marketTime: last.time,
    exchangeTimezone: 'America/New_York',
    dataGranularity: granularity,
    historyStart: points[0]?.time || null,
    historyEnd: points.at(-1)?.time || null,
    points,
  }
  cache.set(cacheKey, { time: Date.now(), data })
  return data
}

async function fetchSinaIndexTrend(key, period) {
  const instrument = instruments[key]
  const cacheKey = `sina-index:${key}:${period}`
  const cached = cache.get(cacheKey)
  if (cached && Date.now() - cached.time < CACHE_TTL) return cached.data

  let source
  let granularity
  if (period === '1D' || period === '5D') {
    const url = `https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var%20_data=/US_MinKService.getMinK?symbol=.${key}&type=1`
    const payload = await fetchSinaPayload(url)
    const latestDate = payload.at(-1)?.d?.slice(0, 10)
    source = period === '1D' ? payload.filter((row) => row.d.startsWith(latestDate)) : payload
    granularity = '1m'
  } else {
    const url = `https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var%20_data=/US_MinKService.getDailyK?symbol=.${key}`
    const payload = await fetchSinaPayload(url)
    const calendarDays = period === '1M' ? 32 : period === '3M' ? 95 : period === '1Y' ? 370 : period === '5Y' ? 1900 : null
    const lastTime = Date.parse(`${payload.at(-1)?.d}T00:00:00-04:00`)
    const cutoff = calendarDays ? lastTime - calendarDays * 86_400_000 : 0
    source = payload.filter((row) => Date.parse(`${row.d}T00:00:00-04:00`) >= cutoff)
    granularity = '1d'
  }

  const points = source
    .map((row) => {
      const dateTime = row.d.includes(' ') ? row.d.replace(' ', 'T') : `${row.d}T00:00:00`
      return {
        time: Math.floor(Date.parse(`${dateTime}-04:00`) / 1000),
        open: finite(Number(row.o)),
        high: finite(Number(row.h)),
        low: finite(Number(row.l)),
        close: finite(Number(row.c)),
        volume: finite(Number(row.v)),
      }
    })
    .filter((point) => Number.isFinite(point.time) && point.close !== null)
  if (!points.length) throw new Error('指数趋势数据为空')

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
    currency: 'USD',
    exchange: 'NASDAQ',
    price: last.close,
    previousClose,
    change,
    changePercent: change !== null && previousClose ? (change / previousClose) * 100 : null,
    dayHigh: Math.max(...closes),
    dayLow: Math.min(...closes),
    marketTime: last.time,
    exchangeTimezone: 'America/New_York',
    dataGranularity: granularity,
    historyStart: points[0]?.time || null,
    historyEnd: points.at(-1)?.time || null,
    points,
  }
  cache.set(cacheKey, { time: Date.now(), data })
  return data
}

async function fetchSinaMainlandTrend(key, period) {
  const instrument = instruments[key]
  const cacheKey = `sina-mainland:${key}:${period}`
  const cached = cache.get(cacheKey)
  if (cached && Date.now() - cached.time < (period === 'MAX' ? 300_000 : CACHE_TTL)) return cached.data
  const symbol = key === 'SSE' ? 'sh000001' : key === 'SZSE' ? 'sz399001' : 'sz399006'
  const response = await fetch(`https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${symbol}&scale=240&ma=no&datalen=50000`, {
    headers: { Referer: 'https://finance.sina.com.cn/', 'User-Agent': 'Mozilla/5.0 Market Dashboard' },
  })
  if (!response.ok) throw new Error(`A股历史服务返回 ${response.status}`)
  const rows = await response.json()
  const days = period === '5D' ? 8 : period === '1M' ? 32 : period === '3M' ? 95 : period === '1Y' ? 370 : period === '5Y' ? 1900 : null
  const lastDate = rows.at(-1)?.day
  const cutoff = days ? Date.parse(lastDate) - days * 86_400_000 : 0
  const points = rows.filter((row) => !cutoff || Date.parse(row.day) >= cutoff).map((row) => ({
    time: Math.floor(Date.parse(`${row.day}T00:00:00+08:00`) / 1000),
    open: finite(Number(row.open)), high: finite(Number(row.high)), low: finite(Number(row.low)), close: finite(Number(row.close)), volume: finite(Number(row.volume)),
  }))
  if (!points.length) throw new Error('A股历史数据为空')
  const last = points.at(-1)
  const previousClose = points.at(-2)?.close ?? null
  const change = previousClose === null ? null : last.close - previousClose
  const closes = points.map((point) => point.close)
  const data = {
    key, symbol: instrument.symbol, name: instrument.name, englishName: instrument.englishName, contract: instrument.contract,
    kind: instrument.kind, unit: instrument.unit, currency: 'CNY', exchange: 'SSE/SZSE', price: last.close,
    previousClose, change, changePercent: change !== null && previousClose ? (change / previousClose) * 100 : null,
    dayHigh: Math.max(...closes), dayLow: Math.min(...closes), marketTime: last.time,
    exchangeTimezone: 'Asia/Shanghai', dataGranularity: '1d', points,
    historyStart: points[0]?.time || null, historyEnd: points.at(-1)?.time || null,
  }
  cache.set(cacheKey, { time: Date.now(), data })
  return data
}

async function fetchGlobalHistoryTrend(key, period) {
  const instrument = instruments[key]
  const cacheKey = `global-history:${key}:${period}`
  const cached = cache.get(cacheKey)
  if (cached && Date.now() - cached.time < 300_000) return cached.data

  let payload = globalHistoryCache.get(key)
  if (!payload) {
    const filePath = path.join(root, 'data', 'global-history', `${key}.json`)
    payload = JSON.parse(await readFile(filePath, 'utf8'))
    globalHistoryCache.set(key, payload)
  }

  // Keep the bundled inception-to-present series current with the public daily feed.
  const sourceSymbol = { FTSE: 'UKX', DAX: 'DAX', KOSPI: 'KOSPI', NIKKEI: 'NKY' }[key]
  try {
    if (!sourceSymbol) throw new Error('没有可用的新浪增量源')
    const response = await fetch(`https://gi.finance.sina.com.cn/hq/daily?symbol=${sourceSymbol}&num=10000`, {
      headers: { Referer: 'https://finance.sina.com.cn/', 'User-Agent': 'Mozilla/5.0 Market Dashboard' },
    })
    if (response.ok) {
      const latestRows = (await response.json())?.result?.data || []
      const merged = new Map(payload.points.map((row) => [row[0], row]))
      for (const row of latestRows) {
        const time = Math.floor(Date.parse(`${row.d}T00:00:00Z`) / 1000)
        const close = finite(Number(row.c))
        if (!Number.isFinite(time) || close === null) continue
        merged.set(time, [time, finite(Number(row.o)), finite(Number(row.h)), finite(Number(row.l)), close, finite(Number(row.v))])
      }
      payload.points = [...merged.values()].sort((a, b) => a[0] - b[0])
    }
  } catch {
    // Bundled history remains available when the refresh feed is unavailable.
  }

  const calendarDays = period === '1D' ? 3 : period === '5D' ? 9 : period === '1M' ? 32 : period === '3M' ? 95 : period === '1Y' ? 370 : period === '5Y' ? 1900 : null
  const latest = payload.points.at(-1)?.[0] || 0
  const cutoff = calendarDays ? latest - calendarDays * 86_400 : 0
  const points = payload.points
    .filter((row) => !cutoff || row[0] >= cutoff)
    .map((row) => ({ time: row[0], open: finite(row[1]), high: finite(row[2]), low: finite(row[3]), close: finite(row[4]), volume: finite(row[5]) }))
    .filter((point) => Number.isFinite(point.time) && point.close !== null)
  if (!points.length) throw new Error('全球指数历史数据为空')

  const last = points.at(-1)
  const previousClose = points.at(-2)?.close ?? null
  const change = previousClose === null ? null : last.close - previousClose
  const closes = points.map((point) => point.close)
  const exchangeTimezone = {
    IXIC: 'America/New_York',
    FTSE: 'Europe/London',
    DAX: 'Europe/Berlin',
    KOSPI: 'Asia/Seoul',
    NIKKEI: 'Asia/Tokyo',
  }[key] || 'UTC'
  const data = {
    key, symbol: instrument.symbol, name: instrument.name, englishName: instrument.englishName, contract: instrument.contract,
    kind: instrument.kind, unit: instrument.unit, currency: payload.currency || 'USD', exchange: payload.exchange || 'Global', price: last.close,
    previousClose, change, changePercent: change !== null && previousClose ? (change / previousClose) * 100 : null,
    dayHigh: Math.max(...closes), dayLow: Math.min(...closes), marketTime: last.time,
    exchangeTimezone, dataGranularity: '1d', points,
    historyStart: payload.points[0]?.[0] || null, historyEnd: payload.points.at(-1)?.[0] || null,
  }
  cache.set(cacheKey, { time: Date.now(), data })
  return data
}

function finite(value) {
  return Number.isFinite(value) ? value : null
}

function getSessionState(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const value = (type) => parts.find((part) => part.type === type)?.value || ''
  const weekday = value('weekday')
  const minutes = (Number(value('hour')) % 24) * 60 + Number(value('minute'))
  const newYorkTime = `${weekday} ${value('hour')}:${value('minute')}:${value('second')}`

  if (weekday === 'Sat' || (weekday === 'Sun' && minutes < 1080) || (weekday === 'Fri' && minutes >= 1020)) {
    return { phase: 'closed', label: '周末休市', detail: '电子盘周日 18:00 ET 开盘', newYorkTime }
  }
  if (minutes >= 1020 && minutes < 1080) {
    return { phase: 'maintenance', label: 'CME 每日维护', detail: '18:00 ET 恢复电子盘', newYorkTime }
  }
  if (minutes >= 570 && minutes < 960) {
    return { phase: 'open', label: '美股正盘 · 电子盘交易中', detail: 'CME 电子盘交易中', newYorkTime }
  }
  if (minutes >= 240 && minutes < 570) {
    return { phase: 'open', label: '盘前 / 夜盘', detail: 'CME 电子盘交易中', newYorkTime }
  }
  return { phase: 'open', label: '盘后 / 夜盘', detail: 'CME 电子盘交易中', newYorkTime }
}

async function fetchChart(key, period) {
  const instrument = instruments[key]
  const span = ranges[period]
  if (!instrument || !span) throw new Error('不支持的合约或时间范围')

  const cacheKey = `${key}:${period}`
  const cached = cache.get(cacheKey)
  if (cached && Date.now() - cached.time < CACHE_TTL) return cached.data

  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(instrument.symbol)}`)
  url.searchParams.set('interval', span.interval)
  url.searchParams.set('range', span.range)
  url.searchParams.set('includePrePost', 'true')
  url.searchParams.set('events', 'div,splits')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8_000)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 Market Dashboard',
      },
    })
    if (!response.ok) throw new Error(`上游行情服务返回 ${response.status}`)
    const body = await response.json()
    const result = body?.chart?.result?.[0]
    if (!result) throw new Error(body?.chart?.error?.description || '行情数据为空')

    const meta = result.meta || {}
    const quote = result.indicators?.quote?.[0] || {}
    const timestamps = result.timestamp || []
    const points = timestamps
      .map((time, index) => ({
        time,
        open: finite(quote.open?.[index]),
        high: finite(quote.high?.[index]),
        low: finite(quote.low?.[index]),
        close: finite(quote.close?.[index]),
        volume: finite(quote.volume?.[index]),
      }))
      .filter((point) => point.close !== null)

    const last = points.at(-1)
    const previousClose = finite(meta.chartPreviousClose ?? meta.previousClose)
    const price = finite(meta.regularMarketPrice) ?? last?.close ?? null
    const change = price !== null && previousClose !== null ? price - previousClose : null
    const changePercent = change !== null && previousClose ? (change / previousClose) * 100 : null

    const data = {
      key,
      symbol: instrument.symbol,
      name: instrument.name,
      englishName: instrument.englishName,
      contract: instrument.contract,
      kind: instrument.kind,
      unit: instrument.unit,
      currency: meta.currency || 'USD',
      exchange: meta.fullExchangeName || meta.exchangeName || 'CME',
      price,
      previousClose,
      change,
      changePercent,
      dayHigh: finite(meta.regularMarketDayHigh),
      dayLow: finite(meta.regularMarketDayLow),
      marketTime: finite(meta.regularMarketTime) ?? last?.time ?? null,
      exchangeTimezone: meta.exchangeTimezoneName || 'America/New_York',
      dataGranularity: meta.dataGranularity || span.interval,
      points,
    }
    cache.set(cacheKey, { time: Date.now(), data })
    return data
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchSinaQuotes() {
  if (Date.now() - sinaCache.time < CACHE_TTL) return sinaCache.data
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 6_000)
  try {
    const response = await fetch('https://hq.sinajs.cn/list=hf_NQ,hf_ES,hf_YM,hf_XAU,gb_ixic,fx_susdcny,b_UKX,b_DAX,b_KOSPI,b_NKY,sh000001,sz399001,sz399006', {
      signal: controller.signal,
      headers: {
        Referer: 'https://finance.sina.com.cn/',
        'User-Agent': 'Mozilla/5.0 Market Dashboard',
      },
    })
    if (!response.ok) throw new Error(`新浪行情返回 ${response.status}`)
    const text = new TextDecoder('gb18030').decode(await response.arrayBuffer())
    const quotes = new Map()
    for (const match of text.matchAll(/hq_str_hf_(NQ|ES|YM|XAU)="([^"]*)"/g)) {
      const values = match[2].split(',')
      const parsedTime = Date.parse(`${values[12]}T${values[6]}+08:00`)
      quotes.set(match[1], {
        price: finite(Number(values[0])),
        dayHigh: finite(Number(values[4])),
        dayLow: finite(Number(values[5])),
        previousClose: finite(Number(values[7])),
        open: finite(Number(values[8])),
        marketTime: Number.isFinite(parsedTime) ? Math.floor(parsedTime / 1000) : null,
      })
    }
    const indexMatch = text.match(/hq_str_gb_ixic="([^"]*)"/)
    if (indexMatch) {
      const values = indexMatch[1].split(',')
      const parsedTime = Date.parse(`${values[3].replace(' ', 'T')}+08:00`)
      quotes.set('IXIC', {
        price: finite(Number(values[1])),
        dayHigh: finite(Number(values[6])),
        dayLow: finite(Number(values[7])),
        previousClose: finite(Number(values[26])) ?? finite(Number(values[1]) - Number(values[4])),
        open: finite(Number(values[5])),
        marketTime: Number.isFinite(parsedTime) ? Math.floor(parsedTime / 1000) : null,
      })
    }
    const globalSymbols = { UKX: 'FTSE', DAX: 'DAX', KOSPI: 'KOSPI', NKY: 'NIKKEI' }
    for (const [sourceKey, key] of Object.entries(globalSymbols)) {
      const match = text.match(new RegExp(`hq_str_b_${sourceKey}=\\"([^\\"]*)\\"`))
      if (!match) continue
      const values = match[1].split(',')
      const timeText = values[6] && values[5] ? `${values[6]}T${values[5]}+08:00` : ''
      const parsedTime = Date.parse(timeText)
      const price = finite(Number(values[1]))
      const previousClose = finite(Number(values[9]))
      quotes.set(key, {
        price,
        dayHigh: finite(Number(values[10])),
        dayLow: finite(Number(values[11])),
        previousClose,
        open: finite(Number(values[8])),
        marketTime: Number.isFinite(parsedTime) ? Math.floor(parsedTime / 1000) : null,
      })
    }
    const mainlandSymbols = { sh000001: 'SSE', sz399001: 'SZSE', sz399006: 'ChiNext' }
    for (const [sourceKey, key] of Object.entries(mainlandSymbols)) {
      const match = text.match(new RegExp(`hq_str_${sourceKey}=\\"([^\\"]*)\\"`))
      if (!match) continue
      const values = match[1].split(',')
      const price = finite(Number(values[3])) || finite(Number(values[2]))
      const previousClose = finite(Number(values[2]))
      const parsedTime = Date.parse(`${values[30]}T${values[31]}+08:00`)
      quotes.set(key, {
        price,
        dayHigh: finite(Number(values[4])),
        dayLow: finite(Number(values[5])),
        previousClose,
        open: finite(Number(values[1])),
        marketTime: Number.isFinite(parsedTime) ? Math.floor(parsedTime / 1000) : null,
      })
    }
    const fxMatch = text.match(/hq_str_fx_susdcny="([^"]*)"/)
    let fx = null
    if (fxMatch) {
      const values = fxMatch[1].split(',')
      const parsedTime = Date.parse(`${values[17]}T${values[0]}+08:00`)
      fx = {
        symbol: 'USD/CNY',
        rate: finite(Number(values[8])),
        marketTime: Number.isFinite(parsedTime) ? Math.floor(parsedTime / 1000) : null,
      }
    }
    if (!quotes.size) throw new Error('新浪行情数据为空')
    const data = { quotes, fx }
    sinaCache = { time: Date.now(), data }
    return data
  } finally {
    clearTimeout(timeout)
  }
}

function quoteOnlyMarket(key, quote) {
  const instrument = instruments[key]
  const change = quote.price !== null && quote.previousClose !== null ? quote.price - quote.previousClose : null
  return {
    key,
    symbol: instrument.symbol,
    name: instrument.name,
    englishName: instrument.englishName,
    contract: instrument.contract,
    kind: instrument.kind,
    unit: instrument.unit,
    currency: 'USD',
    exchange: key === 'IXIC' ? 'NASDAQ' : key === 'XAU' ? 'LBMA' : 'CME',
    price: quote.price,
    previousClose: quote.previousClose,
    change,
    changePercent: change !== null && quote.previousClose ? (change / quote.previousClose) * 100 : null,
    dayHigh: quote.dayHigh,
    dayLow: quote.dayLow,
    marketTime: quote.marketTime,
    exchangeTimezone: 'America/New_York',
    dataGranularity: 'quote',
    points: quote.price === null ? [] : [{ time: quote.marketTime || Math.floor(Date.now() / 1000), close: quote.price }],
  }
}

app.disable('x-powered-by')

app.get('/api/health', (request, response) => {
  response.json({ ok: true, service: 'market-dashboard', time: Math.floor(Date.now() / 1000) })
})

app.get('/api/fundamentals', async (_request, response) => {
  response.set('Cache-Control', 'no-store')
  try {
    return response.json(await fetchFundamentals())
  } catch {
    return response.status(502).json({ error: '企业估值数据暂不可用，请稍后重试' })
  }
})

app.get('/api/housing', async (_request, response) => {
  response.set('Cache-Control', 'no-store')
  try {
    return response.json(await fetchHousingData())
  } catch {
    return response.status(502).json({ error: '住宅价格指数暂不可用，请稍后重试' })
  }
})

app.get('/api/etf-total-return', async (request, response) => {
  response.set('Cache-Control', 'no-store')
  const key = request.query.key ?? 'NF_DIV_LV50'
  if (typeof key !== 'string' || (key !== 'NF_DIV_LV50' && !Object.hasOwn(FUND_LINK_INSTRUMENTS, key))) return response.status(400).json({ error: '暂不支持该基金的总回报数据' })
  try {
    return response.json(await fetchEtfTotalReturn(key))
  } catch {
    return response.status(502).json({ error: '红利再投资数据暂不可用，请稍后重试' })
  }
})

app.get('/api/markets', async (request, response) => {
  const period = String(request.query.period || '1D').toUpperCase()
  if (!ranges[period]) return response.status(400).json({ error: '不支持的时间范围' })
  const usCashSession = getUsCashSession()

  const keys = Object.keys(instruments)
  const [sinaResult, usResult, ...results] = await Promise.allSettled([
    fetchSinaQuotes(),
    fetchUsQuotes(),
    ...keys.map((key) => {
      if (key === 'CFETS') return fetchCfetsTrend(period)
      if (key === 'USDCNY') return fetchCnyTrend(period)
      if (Object.hasOwn(FUND_LINK_INSTRUMENTS, key)) return fetchFundNavTrend(key, period)
      if (Object.hasOwn(HK_STOCKS_INSTRUMENTS, key)) return fetchHkStockTrend(key, period)
      if (key === 'HSTECH') return fetchHstechTrend(period)
      if (Object.hasOwn(MAINLAND_INSTRUMENTS, key)) return fetchMainlandStockTrend(key, period)
      if (Object.hasOwn(DIVIDEND_INDEX_INSTRUMENTS, key)) return fetchDividendIndexTrend(key, period)
      const trend = key === 'IXIC'
        ? fetchGlobalHistoryTrend(key, period)
        : Object.hasOwn(US_INSTRUMENTS, key)
          ? fetchUsTrend(key, period)
        : ['SSE', 'SZSE', 'ChiNext'].includes(key)
          ? fetchSinaMainlandTrend(key, period)
          : ['FTSE', 'DAX', 'KOSPI', 'NIKKEI'].includes(key)
            ? fetchGlobalHistoryTrend(key, period)
          : fetchSinaTrend(key, period)
      return trend.catch(() => fetchChart(key, period))
    }),
  ])
  const quotes = sinaResult.status === 'fulfilled' ? sinaResult.value.quotes : new Map()
  const usQuotes = usResult.status === 'fulfilled' ? usResult.value : new Map()
  const fx = sinaResult.status === 'fulfilled' ? sinaResult.value.fx : null
  const markets = results.flatMap((result, index) => {
    const key = keys[index]
    const quote = usQuotes.get(key) || quotes.get(key)
    if (result.status === 'rejected') {
      if (quote) return [quoteOnlyMarket(key, quote)]
      if (Object.hasOwn(FUND_LINK_INSTRUMENTS, key) || Object.hasOwn(MAINLAND_INSTRUMENTS, key) || Object.hasOwn(DIVIDEND_INDEX_INSTRUMENTS, key) || ['CFETS', 'USDCNY', 'HSBC', 'STAN', 'TENCENT', 'HSTECH', 'KO', 'MCD', 'NVDA', 'AAPL', 'PDD'].includes(key)) return [{
        ...instruments[key], key, price: null, previousClose: null, change: null, changePercent: null,
        dayHigh: null, dayLow: null, marketTime: null, historyStart: null, historyEnd: null,
        exchangeTimezone: instruments[key].exchangeTimezone || 'Asia/Shanghai', dataGranularity: 'unavailable', points: [],
        dataNote: `数据暂不可用：${result.reason?.message || '获取失败'}，稍后自动重试。`,
      }]
      return []
    }
    if (!quote) return [result.value]
    const change = quote.price !== null && quote.previousClose !== null ? quote.price - quote.previousClose : null
    const points = [...result.value.points]
    if (
      period === '1D'
      && quote.price !== null
      && quote.marketTime
      && (!points.length || quote.marketTime > points.at(-1).time)
    ) {
      points.push({ time: quote.marketTime, open: null, high: null, low: null, close: quote.price, volume: null })
    }
    return [{
      ...result.value,
      price: quote.price ?? result.value.price,
      previousClose: quote.previousClose ?? result.value.previousClose,
      change: change ?? result.value.change,
      changePercent: change !== null && quote.previousClose ? (change / quote.previousClose) * 100 : result.value.changePercent,
      dayHigh: quote.dayHigh ?? result.value.dayHigh,
      dayLow: quote.dayLow ?? result.value.dayLow,
      marketTime: quote.marketTime ?? result.value.marketTime,
      points,
    }]
  })
  const errors = results.flatMap((result, index) =>
    result.status === 'rejected'
      ? [{ key: keys[index], message: `走势图：${result.reason?.message || '获取失败'}` }]
      : result.value.isStale ? [{ key: keys[index], message: '更新失败，显示缓存数据' }] : [],
  )
  if (sinaResult.status === 'rejected') errors.push({ key: 'QUOTE', message: `最新报价：${sinaResult.reason?.message || '获取失败'}` })
  if (usResult.status === 'rejected') errors.push({ key: 'US_QUOTE', message: `美股最新报价：${usResult.reason?.message || '获取失败'}` })
  if (!markets.length) return response.status(502).json({ error: '暂时无法连接行情服务', details: errors })
  response.set('Cache-Control', 'no-store')
  return response.json({
    asOf: Math.floor(Date.now() / 1000),
    period,
    feed: '新浪 / 腾讯 / 东方财富 / 中国货币网',
    delay: '参考行情 · 延迟未知',
    session: getSessionState(),
    usCashSession,
    fx,
    markets,
    errors,
  })
})

app.use(express.static(path.join(root, 'dist')))
app.get('*path', (request, response) => {
  response.sendFile(path.join(root, 'dist', 'index.html'))
})

app.listen(port, () => {
  console.log(`Market dashboard server: http://localhost:${port}`)
})
