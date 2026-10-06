import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// This is the same public history feed used by the official CFETS chart.
const HISTORY_URL = 'https://www.chinamoney.com.cn/ags/ms/cm-u-bk-fx/RmbIdxChrt?indexType=3'
const SOURCE_URL = 'https://www.chinamoney.com.cn/chinese/bkrmbidx/'
const CACHE_FILE = fileURLToPath(new URL('./data/cfets-history-cache.json', import.meta.url))
const DAY_SECONDS = 86_400
const PERIOD_DAYS = { '5D': 5, '1M': 31, '3M': 93, '1Y': 366, '5Y': 1827 }

export const CFETS_INSTRUMENT = {
  symbol: 'CFETS',
  name: 'CFETS人民币汇率指数',
  englishName: 'CFETS RMB Index',
  contract: '人民币对一篮子货币的综合汇率指数',
  kind: 'index',
  unit: '点',
  currency: 'CNY',
  exchange: 'CFETS',
}

function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const milliseconds = Date.parse(`${value}T00:00:00Z`)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 10) !== value) return null
  return milliseconds / 1000
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) throw new Error('CFETS 官方历史数据格式异常')
  const points = new Map()
  for (const row of rows) {
    const time = parseDate(row?.showDateCn)
    const close = row?.indexRate === null || row?.indexRate === '' ? NaN : Number(row?.indexRate)
    if (time === null || !Number.isFinite(close) || close <= 0) continue
    // These observations are published index levels, not traded OHLC bars.
    points.set(time, { time, close, open: null, high: null, low: null, volume: null })
  }
  const result = [...points.values()].sort((a, b) => a.time - b.time)
  if (!result.length) throw new Error('CFETS 官方历史数据为空')
  return result
}

function toRows(points) {
  if (!Array.isArray(points)) return []
  return points.filter((point) => Number.isFinite(point?.time)).map((point) => ({
    showDateCn: new Date(point.time * 1000).toISOString().slice(0, 10),
    indexRate: point.close,
  }))
}

function selectPoints(points, period) {
  if (period === '1D') return points.slice(-1)
  if (period === 'MAX') return points
  const days = PERIOD_DAYS[period]
  if (!days) throw new Error(`不支持的 CFETS 周期：${period}`)
  const cutoff = points.at(-1).time - days * DAY_SECONDS
  return points.filter((point) => point.time >= cutoff)
}

function makeMarket(cached, period, isStale = false) {
  const allPoints = cached.points
  const last = allPoints.at(-1)
  const previousClose = allPoints.at(-2)?.close ?? null
  const change = previousClose === null ? null : Number((last.close - previousClose).toFixed(2))
  const firstDate = new Date(allPoints[0].time * 1000).toISOString().slice(0, 10)
  const dataNote = `每周、每月首个交易日08:30发布上期末指数，涨跌相比上一发布值；基期2014-12-31=100，公开历史始于${firstDate}。`
  return {
    key: 'CFETS',
    ...CFETS_INSTRUMENT,
    price: last.close,
    previousClose,
    change,
    changePercent: change !== null && previousClose ? (change / previousClose) * 100 : null,
    dayHigh: null,
    dayLow: null,
    marketTime: last.time,
    exchangeTimezone: 'Asia/Shanghai',
    dataGranularity: 'weekly/month-end',
    historyStart: allPoints[0].time,
    historyEnd: last.time,
    points: selectPoints(allPoints, period),
    sourceName: '中国货币网（中国外汇交易中心）',
    sourceUrl: SOURCE_URL,
    frequency: '每周 / 每月发布',
    precision: 2,
    dataNote: isStale ? `官方数据暂时连接失败，正在显示历史缓存。${dataNote}` : dataNote,
    isStale,
    fetchedAt: cached.fetchedAt,
  }
}

// Dependency injection keeps timeout/cache tests independent of live publication dates.
export function createCfetsClient({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  cacheFile = CACHE_FILE,
  cacheTtlMs = 15 * 60_000,
  timeoutMs = 8_000,
} = {}) {
  let cached = null
  let diskLoad = null
  let pending = null

  async function readCache() {
    if (!cacheFile) return
    try {
      const saved = JSON.parse(await readFile(cacheFile, 'utf8'))
      if (saved.source !== HISTORY_URL || !Number.isFinite(saved.fetchedAt) || saved.fetchedAt > now()) return
      cached = { fetchedAt: saved.fetchedAt, points: normalizeRows(toRows(saved.points)) }
    } catch {
      // Missing or invalid local cache must never manufacture an index level.
    }
  }

  async function refresh() {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(HISTORY_URL, {
        signal: controller.signal,
        headers: { Referer: SOURCE_URL, 'User-Agent': 'Mozilla/5.0 Market Dashboard' },
      })
      if (!response.ok) throw new Error(`CFETS 官方服务返回 ${response.status}`)
      const payload = await response.json()
      if (payload.head?.rep_code && String(payload.head.rep_code) !== '200') {
        throw new Error('CFETS 官方服务返回异常状态')
      }
      const freshPoints = normalizeRows(payload.records)
      // Keep previously retrieved official observations if the upstream later limits its window.
      const points = normalizeRows([...toRows(cached?.points), ...toRows(freshPoints)])
      cached = { points, fetchedAt: now() }
      if (cacheFile) {
        try {
          await mkdir(dirname(cacheFile), { recursive: true })
          const temporary = `${cacheFile}.${process.pid}.tmp`
          await writeFile(temporary, JSON.stringify({ source: HISTORY_URL, ...cached }), 'utf8')
          await rename(temporary, cacheFile)
        } catch {
          // A read-only disk must not discard a successful official response.
        }
      }
      return { cached, isStale: false }
    } catch (error) {
      if (cached) return { cached, isStale: true }
      throw new Error(`CFETS 官方数据暂不可用：${error.name === 'AbortError' ? '请求超时' : error.message}`)
    } finally {
      clearTimeout(timer)
    }
  }

  return async function fetchCfetsTrend(period = 'MAX') {
    if (!diskLoad) diskLoad = readCache()
    await diskLoad
    if (cached && now() - cached.fetchedAt < cacheTtlMs) return makeMarket(cached, period)
    if (!pending) pending = refresh().finally(() => { pending = null })
    const result = await pending
    return makeMarket(result.cached, period, result.isStale)
  }
}

export const fetchCfetsTrend = createCfetsClient()
