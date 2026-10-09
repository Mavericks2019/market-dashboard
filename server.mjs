import express from 'express'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { US_INSTRUMENTS, fetchUsQuotes, fetchUsTrend } from './us-markets.mjs'
import { getUsCashSession } from './us-session.mjs'
import { CFETS_INSTRUMENT, fetchCfetsTrend } from './cfets-market.mjs'
import { CNY_INSTRUMENT, EUR_CNY_INSTRUMENT, fetchCnyTrend, fetchEurCnyTrend, parseCnyQuote, parseEurCnyQuote } from './cny-market.mjs'
import { HK_STOCKS_INSTRUMENTS, fetchHkStockTrend, fetchHkStockQuotes } from './hk-stocks.mjs'
import { HSTECH_INSTRUMENT, fetchHstechTrend, parseHstechQuote } from './hstech-market.mjs'
import { HXC_INSTRUMENT, fetchHxcTrend, parseHxcSinaQuote } from './hxc-market.mjs'
import { MAINLAND_INSTRUMENTS, MAINLAND_ETF_INSTRUMENTS, MAINLAND_STOCKS_INSTRUMENTS, fetchMainlandStockTrend, parseMainlandStockQuote } from './mainland-stocks.mjs'
import { DIVIDEND_INDEX_INSTRUMENTS, fetchDividendIndexTrend, parseDividendMinutes, parseCsiDividendDaily } from './dividend-indices.mjs'
import { fetchFundamentals } from './fundamentals.mjs'
import { fetchIndexConstituents, getConstituent } from './index-constituents.mjs'
import { fetchConstituentValuations } from './constituent-valuations.mjs'
import { fetchHousingData } from './housing-market.mjs'
import { fetchFixedInvestmentData } from './fixed-investment.mjs'
import { FUND_LINK_INSTRUMENTS, fetchEtfTotalReturn, fetchFundNavTrend } from './etf-total-return.mjs'
import { createMarketScheduler } from './market-scheduler.mjs'

const app = express()
const port = Number(process.env.PORT || 4174)
const root = path.dirname(fileURLToPath(import.meta.url))
const cache = new Map()
const CACHE_TTL = 12_000
let sinaCache = { time: 0, data: new Map() }
let sinaPending = null
const globalHistoryCache = new Map()
const dividendQuoteCache = new Map()
const dividendQuotePending = new Map()

const instruments = {
  NQ: { symbol: 'NQ=F', name: '纳斯达克100期货', englishName: 'Nasdaq-100 Futures', contract: 'E-mini Nasdaq-100', kind: 'futures', unit: '点' },
  NDX: US_INSTRUMENTS.NDX,
  IXIC: { symbol: '^IXIC', name: '纳斯达克综合指数', englishName: 'NASDAQ Composite', contract: 'NASDAQ Composite', kind: 'index', unit: '点' },
  HXC: HXC_INSTRUMENT,
  ES: { symbol: 'ES=F', name: '标普500期货', englishName: 'S&P 500 Futures', contract: 'E-mini S&P 500', kind: 'futures', unit: '点' },
  SPX: US_INSTRUMENTS.SPX,
  YM: { symbol: 'YM=F', name: '道琼斯期货', englishName: 'Dow Jones Futures', contract: 'E-mini Dow', kind: 'futures', unit: '点' },
  DJI: US_INSTRUMENTS.DJI,
  XAU: { symbol: 'XAU/USD', name: '伦敦现货金', englishName: 'Spot Gold', contract: 'Spot Gold', kind: 'metal', unit: 'USD/oz' },
  CFETS: CFETS_INSTRUMENT,
  USDCNY: CNY_INSTRUMENT,
  EURCNY: EUR_CNY_INSTRUMENT,
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
    signal: AbortSignal.timeout(8000),
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

export function mergeGlobalDailyRows(existing, incoming) {
  const merged = new Map()
  for (const row of existing) {
    if (!Number.isFinite(row?.[0]) || !Number.isFinite(row?.[4])) continue
    const day = new Date(row[0] * 1000).toISOString().slice(0, 10)
    merged.set(day, [...row])
  }
  for (const row of incoming) {
    if (!Number.isFinite(row?.[0]) || !Number.isFinite(row?.[4])) continue
    const day = new Date(row[0] * 1000).toISOString().slice(0, 10)
    // Keep established session timestamps on overlapping dates. For new daily
    // observations, noon UTC anchors the correct date in every displayed market,
    // including New York through DST; it does not claim an intraday quote time.
    const anchor = merged.get(day)?.[0] ?? Date.parse(`${day}T12:00:00Z`) / 1000
    merged.set(day, [anchor, ...row.slice(1)])
  }
  return [...merged.values()].sort((a, b) => a[0] - b[0])
}

export async function fetchGlobalHistoryTrend(key, period) {
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
  let historyRefreshFailed = false
  try {
    if (key === 'IXIC') {
      const recent = await fetchSinaIndexTrend('IXIC', '1Y')
      payload.points = mergeGlobalDailyRows(payload.points, recent.points.map((point) => [point.time, point.open, point.high, point.low, point.close, point.volume]))
    } else {
      if (!sourceSymbol) throw new Error('没有可用的新浪增量源')
      const response = await fetch(`https://gi.finance.sina.com.cn/hq/daily?symbol=${sourceSymbol}&num=10000`, {
        signal: AbortSignal.timeout(8000),
        headers: { Referer: 'https://finance.sina.com.cn/', 'User-Agent': 'Mozilla/5.0 Market Dashboard' },
      })
      if (!response.ok) throw new Error('全球指数日线刷新失败')
      const latestRows = (await response.json())?.result?.data || []
      const incoming = []
      for (const row of latestRows) {
        const time = Math.floor(Date.parse(`${row.d}T00:00:00Z`) / 1000)
        const close = finite(Number(row.c))
        if (!Number.isFinite(time) || close === null) continue
        incoming.push([time, finite(Number(row.o)), finite(Number(row.h)), finite(Number(row.l)), close, finite(Number(row.v))])
      }
      if (!incoming.length) throw new Error('全球指数日线增量为空')
      payload.points = mergeGlobalDailyRows(payload.points, incoming)
    }
  } catch {
    historyRefreshFailed = true
    payload.points = mergeGlobalDailyRows(payload.points, [])
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
    isStale: historyRefreshFailed,
    dataNote: `${key === 'IXIC' ? '1971年起完整历史与新浪最近日线按交易日合并。' : '完整历史与新浪最近日线按交易日合并。'}${historyRefreshFailed ? `日线刷新失败，历史截至${new Date(last.time * 1000).toISOString().slice(0, 10)}；卡片报价独立更新。` : '图中为每日指数值，日线时间仅标识交易日期；报价卡片可晚于最近完整日线。'}`,
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

async function fetchSinaQuotes(options = {}) {
  if (sinaPending) return sinaPending
  sinaPending = fetchSinaQuotesRequest(options).finally(() => { sinaPending = null })
  return sinaPending
}

export function parseSinaGlobalQuote(values) {
  const date = values[6]
  const clock = values[7]
  const parsedTime = /^\d{4}-\d{2}-\d{2}$/.test(date ?? '') && /^\d{2}:\d{2}:\d{2}$/.test(clock ?? '') ? Date.parse(`${date}T${clock}+08:00`) : NaN
  const price = Number(values[1])
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(parsedTime)) throw new Error('全球指数报价或来源时间无效')
  return { price, previousClose: finite(Number(values[9])), open: finite(Number(values[8])), dayHigh: finite(Number(values[10])), dayLow: finite(Number(values[11])), marketTime: parsedTime / 1000 }
}

async function fetchSinaQuotesRequest({ force = false } = {}) {
  if (!force && Date.now() - sinaCache.time < CACHE_TTL) return sinaCache.data
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 6_000)
  try {
    const symbols = ['hf_NQ', 'hf_ES', 'hf_YM', 'hf_XAU', 'gb_ixic', 'gb_$hxc', 'rt_hkHSTECH', 'fx_susdcny', 'fx_seurcny', 'b_UKX', 'b_DAX', 'b_KOSPI', 'b_NKY', 'sh000001', 'sz399001', 'sz399006', ...Object.values(MAINLAND_INSTRUMENTS).map((item) => item.sourceSymbol)]
    const response = await fetch(`https://hq.sinajs.cn/list=${symbols.join(',')}`, {
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
      try { quotes.set(key, parseSinaGlobalQuote(values)) } catch { /* Missing timestamp is not replaced by the request clock. */ }
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
    for (const [key, parse] of [
      ['HXC', () => parseHxcSinaQuote(text)], ['HSTECH', () => parseHstechQuote(text)], ['USDCNY', () => parseCnyQuote(text)], ['EURCNY', () => parseEurCnyQuote(text)],
      ...Object.entries(MAINLAND_INSTRUMENTS).map(([key, instrument]) => [key, () => parseMainlandStockQuote(text, instrument)]),
    ]) {
      try { quotes.set(key, parse()) } catch { /* A missing member does not discard the other fresh quotes. */ }
    }
    for (const [key, quote] of quotes) if (!Number.isFinite(quote.price) || quote.price <= 0 || !Number.isFinite(quote.marketTime)) quotes.delete(key)
    if (!quotes.size) throw new Error('新浪行情数据为空')
    const data = { quotes, fx }
    sinaCache = { time: Date.now(), data }
    return data
  } finally {
    clearTimeout(timeout)
  }
}

function placeholderMarket(key) {
  const instrument = instruments[key]
  const currency = { FTSE: 'GBP', DAX: 'EUR', KOSPI: 'KRW', NIKKEI: 'JPY', SSE: 'CNY', SZSE: 'CNY', ChiNext: 'CNY' }[key]
  const timezone = { FTSE: 'Europe/London', DAX: 'Europe/Berlin', KOSPI: 'Asia/Seoul', NIKKEI: 'Asia/Tokyo', SSE: 'Asia/Shanghai', SZSE: 'Asia/Shanghai', ChiNext: 'Asia/Shanghai' }[key]
  const exchange = { IXIC: 'NASDAQ', FTSE: 'LSE', DAX: 'Xetra', KOSPI: 'KRX', NIKKEI: 'Tokyo', SSE: 'SSE', SZSE: 'SZSE', ChiNext: 'SZSE', XAU: 'LBMA' }[key]
  return {
    ...instrument, key, currency: instrument.currency ?? currency ?? 'USD', exchange: instrument.exchange ?? exchange ?? 'CME',
    exchangeTimezone: instrument.exchangeTimezone ?? timezone ?? 'America/New_York', price: null, previousClose: null, change: null,
    changePercent: null, dayHigh: null, dayLow: null, marketTime: null, dataGranularity: 'loading', points: [],
  }
}

function quoteOnlyMarket(key, quote) {
  const change = Number.isFinite(quote.price) && Number.isFinite(quote.previousClose) ? quote.price - quote.previousClose : null
  return { ...placeholderMarket(key), ...quote, change, changePercent: change !== null && quote.previousClose ? change / quote.previousClose * 100 : null, dataGranularity: quote.dataGranularity ?? 'quote', points: [] }
}

async function loadMarketHistory(key, period) {
  if (key === 'CFETS') return fetchCfetsTrend(period)
  if (key === 'USDCNY') return fetchCnyTrend(period)
  if (key === 'EURCNY') return fetchEurCnyTrend(period)
  if (key === 'HXC') return fetchHxcTrend(period)
  if (Object.hasOwn(FUND_LINK_INSTRUMENTS, key)) return fetchFundNavTrend(key, period)
  if (Object.hasOwn(HK_STOCKS_INSTRUMENTS, key)) return fetchHkStockTrend(key, period)
  if (key === 'HSTECH') return fetchHstechTrend(period)
  if (Object.hasOwn(MAINLAND_INSTRUMENTS, key)) return fetchMainlandStockTrend(key, period)
  if (Object.hasOwn(DIVIDEND_INDEX_INSTRUMENTS, key)) return fetchDividendIndexTrend(key, period)
  const trend = key === 'IXIC' || ['FTSE', 'DAX', 'KOSPI', 'NIKKEI'].includes(key) ? fetchGlobalHistoryTrend(key, period)
    : Object.hasOwn(US_INSTRUMENTS, key) ? fetchUsTrend(key, period)
      : ['SSE', 'SZSE', 'ChiNext'].includes(key) ? fetchSinaMainlandTrend(key, period) : fetchSinaTrend(key, period)
  return trend.catch(() => fetchChart(key, period))
}

export function parseTencentDividendQuote(text, instrument) {
  const match = text.match(new RegExp(`v_sh${instrument.symbol}="([^"]+)"`))
  const fields = match?.[1].split('~')
  if (!fields || fields[2] !== instrument.symbol || fields[1] !== instrument.providerName) throw new Error('腾讯红利指数身份校验失败')
  const stamp = fields[30]
  const marketTime = /^\d{14}$/.test(stamp ?? '') ? Date.parse(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12)}+08:00`) / 1000 : NaN
  const price = Number(fields[3])
  const previousClose = Number(fields[4])
  if (!(price > 0) || !(previousClose > 0) || !Number.isFinite(marketTime)) throw new Error('腾讯红利指数价格或时间缺失')
  return { price, previousClose, marketTime, dayHigh: finite(Number(fields[33])), dayLow: finite(Number(fields[34])), sourceName: '腾讯财经指数报价', dataNote: '报价与时间来自同一条指数记录。' }
}

export function parseDividendClosingQuote(payload, instrument) {
  const points = parseCsiDividendDaily(payload, instrument)
  const latest = points.at(-1)
  const previousClose = points.at(-2)?.close ?? null
  return { price: latest.close, previousClose, dayHigh: latest.high, dayLow: latest.low, marketTime: latest.time, dataGranularity: '1d',
    sourceName: '中证指数（最近公布日线）', isStale: true,
    dataNote: `分时报价暂不可用，显示${new Date(latest.time * 1000).toISOString().slice(0, 10)}最近公布日线；时间仅表示交易日，非盘中快照。` }
}

async function cachedDividendQuote(key, ttl, load, force = false) {
  const previous = dividendQuoteCache.get(key)
  if (!force && previous && Date.now() - previous.time < ttl) return previous.data
  if (dividendQuotePending.has(key)) return dividendQuotePending.get(key)
  const task = Promise.resolve().then(load).then((data) => {
    dividendQuoteCache.set(key, { time: Date.now(), data })
    return data
  }).finally(() => dividendQuotePending.delete(key))
  dividendQuotePending.set(key, task)
  return task
}

export async function fetchDividendQuote(key, { force = false } = {}) {
  const instrument = DIVIDEND_INDEX_INSTRUMENTS[key]
  if (key === 'CSI_DIV' || key === 'SSE_DIV') {
    try {
      const text = await cachedDividendQuote('tencent-batch', 12_000, async () => {
        const response = await fetch('https://qt.gtimg.cn/q=sh000922,sh000015', { signal: AbortSignal.timeout(6000), headers: { Referer: 'https://gu.qq.com/' } })
        if (!response.ok) throw new Error('腾讯指数报价不可用')
        return new TextDecoder('gb18030').decode(await response.arrayBuffer())
      }, force)
      return quoteOnlyMarket(key, parseTencentDividendQuote(text, instrument))
    } catch { /* Try the independent minute feed, then recent official daily data. */ }
  }
  try {
  const url = `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${instrument.secid}&ndays=1&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57`
  const response = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { Referer: 'https://quote.eastmoney.com/' } })
  if (!response.ok) throw new Error('红利指数分钟报价不可用')
  const { points, previousClose } = parseDividendMinutes(await response.json(), instrument)
  const last = points.at(-1)
  return quoteOnlyMarket(key, { ...instrument, price: last.close, previousClose, marketTime: last.time,
    dayHigh: Math.max(...points.map((point) => point.high ?? point.close)), dayLow: Math.min(...points.map((point) => point.low ?? point.close)),
    sourceName: '东方财富分钟行情', dataNote: '报价与时间取同一条最近分钟记录；休市时保留最近交易日。' })
  } catch {
    const quote = await cachedDividendQuote(`closing:${key}`, 300_000, async () => {
      const end = new Date(Date.now() + 8 * 3600_000)
      const start = new Date(end.getTime() - 45 * 86400_000)
      const format = (date) => date.toISOString().slice(0, 10).replaceAll('-', '')
      const url = `https://www.csindex.com.cn/csindex-home/perf/index-perf?indexCode=${instrument.symbol}&startDate=${format(start)}&endDate=${format(end)}`
      const response = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { Referer: 'https://www.csindex.com.cn/' } })
      if (!response.ok) throw new Error('中证最近日线暂不可用')
      return parseDividendClosingQuote(await response.json(), instrument)
    }, force)
    return quoteOnlyMarket(key, quote)
  }
}

async function fetchFundQuote(key) {
  const instrument = FUND_LINK_INSTRUMENTS[key]
  const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${instrument.fundCode}&pageIndex=1&pageSize=2`
  const response = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { Referer: 'https://fundf10.eastmoney.com/' } })
  if (!response.ok) throw new Error('基金最新公布净值不可用')
  const body = await response.json()
  const rows = body?.Data?.LSJZList
  if (body.ErrCode !== 0 || !Array.isArray(rows) || !rows.length) throw new Error('基金净值格式异常')
  const price = Number(rows[0].DWJZ)
  const marketTime = /^\d{4}-\d{2}-\d{2}$/.test(rows[0].FSRQ) ? Date.parse(`${rows[0].FSRQ}T00:00:00+08:00`) / 1000 : null
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(marketTime)) throw new Error('基金净值或原始日期缺失')
  return quoteOnlyMarket(key, { price, previousClose: rows[1] ? Number(rows[1].DWJZ) : null, marketTime,
    dataGranularity: '1d', sourceName: '天天基金 / 东方财富（单位净值）', sourceUrl: `https://fund.eastmoney.com/${instrument.fundCode}.html`,
    dataNote: '按交易日公布单位净值，无盘中报价；时间为原始净值日期。' })
}

const sinaKeys = ['NQ', 'ES', 'YM', 'XAU', 'IXIC', 'HXC', 'HSTECH', 'USDCNY', 'EURCNY', 'FTSE', 'DAX', 'KOSPI', 'NIKKEI', 'SSE', 'SZSE', 'ChiNext', ...Object.keys(MAINLAND_INSTRUMENTS)]
const scheduler = createMarketScheduler({ instruments, makePlaceholder: placeholderMarket, loadHistory: loadMarketHistory,
  quoteSources: [
    { id: 'sina', keys: sinaKeys, load: async ({ force }) => { const value = await fetchSinaQuotes({ force }); return { ...value, quotes: new Map([...value.quotes].map(([key, quote]) => [key, quoteOnlyMarket(key, quote)])) } } },
    { id: 'us', keys: Object.keys(US_INSTRUMENTS), load: async ({ force }) => new Map([...(await fetchUsQuotes({ force }))].map(([key, quote]) => [key, quoteOnlyMarket(key, quote)])) },
    { id: 'hk', keys: Object.keys(HK_STOCKS_INSTRUMENTS), load: async ({ force }) => new Map([...(await fetchHkStockQuotes({ force }))].map(([key, quote]) => [key, quoteOnlyMarket(key, quote)])) },
    ...Object.keys(DIVIDEND_INDEX_INSTRUMENTS).map((key) => ({ id: key, keys: [key], load: async ({ force }) => new Map([[key, await fetchDividendQuote(key, { force })]]) })),
    ...Object.keys(FUND_LINK_INSTRUMENTS).map((key) => ({ id: key, keys: [key], ttlMs: 300_000, load: async () => new Map([[key, await fetchFundQuote(key)]]) })),
    { id: 'cfets', keys: ['CFETS'], ttlMs: 3600_000, load: async () => new Map([['CFETS', { ...(await fetchCfetsTrend('1M')), points: [] }]]) },
  ],
})

app.disable('x-powered-by')

app.get('/api/health', (request, response) => {
  response.json({ ok: true, service: 'market-dashboard', time: Math.floor(Date.now() / 1000) })
})

app.get('/api/fundamentals', async (request, response) => {
  response.set('Cache-Control', 'no-store')
  try {
    return response.json(await fetchFundamentals({ force: request.query.refresh === '1' }))
  } catch {
    return response.status(502).json({ error: '企业估值数据暂不可用，请稍后重试' })
  }
})

app.get('/api/index-constituents', async (request, response) => {
  response.set('Cache-Control', 'no-store')
  const key = typeof request.query.key === 'string' ? request.query.key : ''
  if (!Object.hasOwn(instruments, key) || !['index', 'futures'].includes(instruments[key].kind) || key === 'CFETS') {
    return response.status(400).json({ error: '请选择股票指数' })
  }
  try {
    response.json(await fetchIndexConstituents(key, { force: request.query.refresh === '1' }))
  } catch {
    response.status(502).json({ error: '成分股名单暂时不可用，请稍后刷新' })
  }
})

app.get('/api/constituent-valuations', async (request, response) => {
  response.set('Cache-Control', 'no-store')
  const symbols = typeof request.query.symbols === 'string' ? request.query.symbols.split(',') : []
  if (!symbols.length || symbols.length > 20 || new Set(symbols).size !== symbols.length) {
    return response.status(400).json({ error: '每批请提交1至20项不重复的成分股' })
  }
  const companies = symbols.map(getConstituent)
  if (companies.some((company) => !company)) return response.status(400).json({ error: '请先获取指数的成分股名单' })
  try {
    response.json(await fetchConstituentValuations(companies, { force: request.query.refresh === '1' }))
  } catch {
    response.status(502).json({ error: '成分股估值暂时不可用，请稍后刷新' })
  }
})

app.get('/api/fixed-investment', async (request, response) => {
  response.set('Cache-Control', 'no-store')
  try {
    return response.json(await fetchFixedInvestmentData({ force: request.query.refresh === '1' }))
  } catch {
    return response.status(502).json({ error: '固定资产投资数据暂不可用，请稍后重试' })
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

app.get('/api/market', (request, response) => {
  response.set('Cache-Control', 'no-store')
  const key = typeof request.query.key === 'string' ? request.query.key : ''
  const period = String(request.query.period || 'MAX').toUpperCase()
  if (!Object.hasOwn(instruments, key) || !Object.hasOwn(ranges, period)) return response.status(400).json({ error: '不支持的标的或时间范围' })
  const result = scheduler.historySnapshot(key, period, { force: request.query.refresh === '1' })
  return response.status(result.market ? 200 : result.pending ? 202 : 502).json(result)
})

app.get('/api/markets', async (request, response) => {
  const period = String(request.query.period || '1D').toUpperCase()
  if (!Object.hasOwn(ranges, period)) return response.status(400).json({ error: '不支持的时间范围' })
  const usCashSession = getUsCashSession()
  response.set('Cache-Control', 'no-store')
  if (request.query.view === 'quotes') {
    const snapshot = await scheduler.quoteSnapshot({ force: request.query.refresh === '1', waitMs: 600 })
    return response.json({ asOf: Math.floor(Date.now() / 1000), period, feed: '新浪 / 腾讯 / 东方财富 / 中国货币网',
      delay: '参考行情 · 延迟未知', session: getSessionState(), usCashSession, ...snapshot })
  }

  const keys = Object.keys(instruments)
  const [sinaResult, usResult, ...results] = await Promise.allSettled([
    fetchSinaQuotes(),
    fetchUsQuotes(),
    ...keys.map((key) => loadMarketHistory(key, period)),
  ])
  const quotes = sinaResult.status === 'fulfilled' ? sinaResult.value.quotes : new Map()
  const usQuotes = usResult.status === 'fulfilled' ? usResult.value : new Map()
  const fx = sinaResult.status === 'fulfilled' ? sinaResult.value.fx : null
  const markets = results.flatMap((result, index) => {
    const key = keys[index]
    const quote = usQuotes.get(key) || quotes.get(key)
    if (result.status === 'rejected') {
      if (quote) return [quoteOnlyMarket(key, quote)]
      if (Object.hasOwn(FUND_LINK_INSTRUMENTS, key) || Object.hasOwn(MAINLAND_INSTRUMENTS, key) || Object.hasOwn(DIVIDEND_INDEX_INSTRUMENTS, key) || ['HXC', 'CFETS', 'USDCNY', 'EURCNY', 'HSBC', 'STAN', 'TENCENT', 'HSTECH', 'KO', 'MCD', 'NVDA', 'AAPL', 'PDD'].includes(key)) return [{
        ...instruments[key], key, price: null, previousClose: null, change: null, changePercent: null,
        dayHigh: null, dayLow: null, marketTime: null, historyStart: null, historyEnd: null,
        exchangeTimezone: instruments[key].exchangeTimezone || 'Asia/Shanghai', dataGranularity: 'unavailable', points: [],
        dataNote: `数据暂不可用：${result.reason?.message || '获取失败'}，稍后自动重试。`,
      }]
      return []
    }
    if (!quote || (Number.isFinite(result.value.marketTime) && (!Number.isFinite(quote.marketTime) || quote.marketTime < result.value.marketTime))) return [result.value]
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  app.listen(port, () => { console.log(`Market dashboard server: http://localhost:${port}`) })
}
