import { useCallback, useEffect, useRef, useState } from 'react'
import type { Market, MarketsResponse, Period } from './types'
import { mergeMarketSnapshot, retainPoints } from './marketData'

type SnapshotResponse = MarketsResponse & { updating?: boolean }
interface HistoryResponse { market?: Market; period: Period; pending?: boolean; updating?: boolean; error?: string }

// Schedule the next poll only after the last request has settled. A slow
// request must never be superseded forever by another interval tick.
export function useMarketQuotes() {
  const [data, setData] = useState<MarketsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [refreshToken, setRefreshToken] = useState(0)
  const refresh = useCallback(() => setRefreshToken((value) => value + 1), [])

  useEffect(() => {
    const controller = new AbortController()
    let timer: number | undefined
    let inFlight = false
    let first = true
    let followups = 0
    const started = Date.now()
    const poll = async () => {
      if (inFlight || controller.signal.aborted) return
      inFlight = true
      setRefreshing(true)
      let next = 15_000
      try {
        const force = first && refreshToken > 0
        first = false
        const response = await fetch(`/api/markets?view=quotes${force ? '&refresh=1' : ''}`, {
          cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        })
        const body = await response.json() as SnapshotResponse & { error?: string }
        if (!response.ok || !Array.isArray(body.markets)) throw new Error(body.error || '报价加载失败')
        if (controller.signal.aborted) return
        setData((previous) => mergeMarketSnapshot(previous, body))
        setError(body.errors?.length ? '部分行情未更新，请查看各项报价时间' : '')
        if (body.updating || body.markets.some((market) => market.dataGranularity === 'loading')) {
          if (Date.now() - started < 30_000 || followups < 5) { next = 1_000; followups++ }
          else followups = 0
        } else followups = 0
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error && reason.name !== 'TimeoutError' ? reason.message : '报价连接超时，保留最近数据')
      } finally {
        inFlight = false
        if (!controller.signal.aborted) {
          setLoading(false)
          setRefreshing(false)
          timer = window.setTimeout(poll, document.hidden ? 30_000 : next)
        }
      }
    }
    const onVisible = () => {
      if (!document.hidden && !inFlight) { window.clearTimeout(timer); void poll() }
    }
    void poll()
    document.addEventListener('visibilitychange', onVisible)
    return () => { controller.abort(); window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [refreshToken])
  return { data, loading, refreshing, error, refresh, refreshToken }
}

export function useMarketHistory(key: Market['key'] | undefined, period: Period, refreshToken: number) {
  const [result, setResult] = useState<{ id: string; market: Market } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const cache = useRef(new Map<string, Market>())
  const previousRefresh = useRef(refreshToken)
  const id = `${key}:${period}`

  useEffect(() => {
    if (!key) return
    const controller = new AbortController()
    let timer: number | undefined
    let first = true
    let inFlight = false
    const forced = previousRefresh.current !== refreshToken
    previousRefresh.current = refreshToken
    const saved = cache.current.get(id)
    setResult(saved ? { id, market: saved } : null)
    setLoading(!saved)
    setError('')
    const started = Date.now()
    const poll = async () => {
      if (inFlight || controller.signal.aborted) return
      inFlight = true
      let next = period === '1D' || period === '5D' ? 15_000 : 300_000
      try {
        const force = first && forced
        first = false
        const response = await fetch(`/api/market?key=${encodeURIComponent(key)}&period=${period}${force ? '&refresh=1' : ''}`, {
          cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        })
        const body = await response.json() as HistoryResponse
        if (!response.ok) throw new Error(body.error || '历史走势加载失败')
        if (controller.signal.aborted) return
        if (response.status === 202 || body.pending) {
          next = Date.now() - started < 60_000 ? 1_500 : 10_000
        } else {
          if (!body.market || body.market.key !== key || body.period !== period) throw new Error('走势图数据不匹配')
          const prior = cache.current.get(id)
          const market = { ...body.market, points: retainPoints(prior?.points, body.market.points) }
          cache.current.delete(id)
          cache.current.set(id, market)
          if (cache.current.size > 8) cache.current.delete(cache.current.keys().next().value!)
          setResult({ id, market })
          setLoading(false)
          setError('')
          if (body.updating) next = 1_500
        }
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error && reason.name !== 'TimeoutError' ? reason.message : '历史数据连接超时，保留最近走势')
          setLoading(false)
          next = 15_000
        }
      } finally {
        inFlight = false
        if (!controller.signal.aborted) timer = window.setTimeout(poll, next)
      }
    }
    void poll()
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [id, key, period, refreshToken])
  return { history: result?.id === id ? result.market : null, loading, error }
}
