import { createHash } from 'node:crypto'

const quoteFields = ['price', 'previousClose', 'change', 'changePercent', 'dayHigh', 'dayLow', 'marketTime', 'regularPrice', 'regularChange', 'regularChangePercent', 'regularMarketTime', 'extendedPrice', 'extendedChange', 'extendedChangePercent', 'extendedMarketTime']

export function mergeMarketQuote(history, quote) {
  if (!quote || !Number.isFinite(quote.price) || !Number.isFinite(quote.marketTime)
    || (Number.isFinite(history.marketTime) && quote.marketTime < history.marketTime)) return history
  const result = { ...history }
  for (const field of quoteFields) if (quote[field] !== undefined) result[field] = quote[field]
  return result
}

export function createMarketScheduler({ instruments, quoteSources, loadHistory, makePlaceholder, now = Date.now, retryMs = 5000, concurrency = 4 }) {
  const quotes = new Map()
  const sources = new Map()
  const histories = new Map()
  const pendingHistory = new Map()
  const queue = []
  let active = 0
  let fx = null
  function limited(load) {
    return new Promise((resolve, reject) => { queue.push({ load, resolve, reject }); drain() })
  }
  function drain() {
    while (active < concurrency && queue.length) {
      const task = queue.shift()
      active++
      Promise.resolve().then(task.load).then(task.resolve, task.reject).finally(() => { active--; drain() })
    }
  }
  function acceptQuote(key, market, receivedAt) {
    const previous = quotes.get(key)
    if (!Number.isFinite(market.price) || !Number.isFinite(market.marketTime)) throw new Error('报价或来源时间缺失')
    if (previous?.market && Number.isFinite(previous.market.marketTime) && market.marketTime < previous.market.marketTime) {
      quotes.set(key, { ...previous, isStale: true, error: '上游返回较早报价，保留较新行情' })
      return
    }
    quotes.set(key, { market: { ...makePlaceholder(key), ...market, key, points: [] }, receivedAt, isStale: Boolean(market.isStale), error: null })
  }
  function refreshSource(source, force = false) {
    let state = sources.get(source.id)
    if (state?.pending) return state.pending
    if (!force && state && state.nextAt > now()) return Promise.resolve()
    state ??= {}
    const task = limited(() => source.load({ force })).then((result) => {
      const batch = result instanceof Map ? result : result.quotes
      if (!(batch instanceof Map)) throw new Error('报价源返回格式异常')
      for (const key of source.keys) {
        try {
          if (!batch.has(key)) throw new Error('本次报价缺失')
          acceptQuote(key, batch.get(key), now())
        } catch (error) {
          const previous = quotes.get(key)
          quotes.set(key, { ...previous, isStale: true, error: error.message })
        }
      }
      if (result.fx && Number.isFinite(result.fx.rate) && result.fx.rate > 0 && Number.isFinite(result.fx.marketTime)
        && (!fx || result.fx.marketTime >= fx.marketTime)) fx = result.fx
      state.nextAt = now() + (source.ttlMs ?? 12_000)
    }).catch((error) => {
      for (const key of source.keys) quotes.set(key, { ...quotes.get(key), isStale: true, error: error.message || '报价刷新失败' })
      state.nextAt = now() + retryMs
    }).finally(() => { state.pending = null })
    state.pending = task
    sources.set(source.id, state)
    return task
  }
  async function quoteSnapshot({ force = false, waitMs = 0 } = {}) {
    const hasCachedQuote = [...quotes.values()].some((entry) => entry.market)
    const tasks = quoteSources.map((source) => refreshSource(source, force))
    if (waitMs > 0 && (!hasCachedQuote || force)) {
      let timer
      await Promise.race([Promise.all(tasks), new Promise((resolve) => { timer = setTimeout(resolve, waitMs) })])
      clearTimeout(timer)
    }
    const markets = Object.keys(instruments).map((key) => {
      const entry = quotes.get(key)
      if (!entry?.market) return { ...makePlaceholder(key), dataGranularity: entry?.error ? 'unavailable' : 'loading', isStale: true, dataNote: entry?.error ? `报价暂不可用：${entry.error}` : '正在获取最新报价。', points: [] }
      return { ...entry.market, isStale: entry.isStale, ...(entry.error ? { dataNote: `${entry.market.dataNote ?? ''} ${entry.error}，保留原始行情时间。`.trim() } : {}), points: [] }
    })
    return { markets, fx, updating: [...sources.values()].some((source) => Boolean(source.pending)), errors: markets.filter((market) => market.isStale && market.dataGranularity !== 'loading').map((market) => ({ key: market.key, message: market.dataNote || '报价刷新失败，显示缓存' })) }
  }
  function startHistory(key, period) {
    const cacheKey = `${key}:${period}`
    if (pendingHistory.has(cacheKey)) return pendingHistory.get(cacheKey)
    const previous = histories.get(cacheKey)
    const task = Promise.resolve().then(() => loadHistory(key, period)).then((market) => {
      if (!Array.isArray(market.points) || !market.points.length || market.points.some((point) => !Number.isFinite(point.time) || !Number.isFinite(point.close))) throw new Error('历史数据为空或无效')
      let points = market.points
      if (period === 'MAX' && previous?.market.points.length) {
        points = [...new Map([...previous.market.points, ...points].map((point) => [point.time, point])).values()].sort((a, b) => a.time - b.time)
      }
      const receivedAt = now()
      const existing = quotes.get(key)
      if (Number.isFinite(market.price) && Number.isFinite(market.marketTime) && (!existing?.market || market.marketTime > existing.market.marketTime)) acceptQuote(key, { ...market, points: [] }, receivedAt)
      const snapshot = { ...market, points, ...(period === 'MAX' ? { historyStart: points[0].time, historyEnd: points.at(-1).time } : {}) }
      const revision = createHash('sha256').update(JSON.stringify(points)).digest('hex').slice(0, 24)
      const ttl = period === '1D' || period === '5D' ? 12_000 : 300_000
      histories.set(cacheKey, { market: snapshot, revision, receivedAt, nextAt: now() + ttl, failed: Boolean(market.isStale) })
    }).catch((error) => {
      histories.set(cacheKey, { ...previous, nextAt: now() + retryMs, failed: true, error: error.message || '历史刷新失败' })
    }).finally(() => pendingHistory.delete(cacheKey))
    pendingHistory.set(cacheKey, task)
    return task
  }
  function historySnapshot(key, period, { force = false } = {}) {
    if (!Object.hasOwn(instruments, key)) throw new Error('未知市场代码')
    const cacheKey = `${key}:${period}`
    const previous = histories.get(cacheKey)
    if (force || !previous || previous.nextAt <= now()) void startHistory(key, period)
    if (!previous?.market) return { pending: pendingHistory.has(cacheKey), key, period, asOf: Math.floor(now() / 1000), ...(previous?.error ? { error: previous.error } : {}) }
    const isStale = previous.failed
    const market = mergeMarketQuote(previous.market, quotes.get(key)?.market)
    return { market: { ...market, isStale, ...(previous.error ? { dataNote: `${market.dataNote ?? ''} 历史刷新失败，保留完整缓存。`.trim() } : {}) }, period, asOf: Math.floor(previous.receivedAt / 1000), revision: previous.revision, updating: pendingHistory.has(cacheKey) }
  }
  return { quoteSnapshot, historySnapshot }
}
