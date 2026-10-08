import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, TrendingUp } from 'lucide-react'
import {
  AreaSeries,
  ColorType,
  CrosshairMode,
  createChart,
  type IChartApi,
  type MouseEventParams,
  type UTCTimestamp,
} from 'lightweight-charts'
import type { ChartPoint, EtfTotalReturnResponse } from './types'

type ReturnPeriod = '1M' | '3M' | '1Y' | '5Y' | 'MAX'
const periods: Array<{ value: ReturnPeriod; label: string }> = [
  { value: '1M', label: '1月' },
  { value: '3M', label: '3月' },
  { value: '1Y', label: '1年' },
  { value: '5Y', label: '5年' },
  { value: 'MAX', label: '全部' },
]
const signed = new Intl.NumberFormat('zh-CN', { signDisplay: 'always', minimumFractionDigits: 2, maximumFractionDigits: 2 })

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestamp * 1000))
}

function TotalReturnChart({ points, baseValue, period, name, fundCode }: { points: ChartPoint[]; baseValue: number; period: ReturnPeriod; name: string; fundCode: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const [tooltip, setTooltip] = useState<{ point: ChartPoint; x: number; y: number } | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container || !points.length) return
    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#77808f', fontFamily: 'Inter, "Microsoft YaHei", sans-serif', fontSize: 11 },
      grid: { vertLines: { color: 'rgba(255,255,255,0.035)' }, horzLines: { color: 'rgba(255,255,255,0.05)' } },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#697386', labelBackgroundColor: '#343a45' },
        horzLine: { color: '#697386', labelBackgroundColor: '#343a45' },
      },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)', scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: { borderColor: 'rgba(255,255,255,0.08)', timeVisible: false, rightOffset: 0, minBarSpacing: 0.01, lockVisibleTimeRangeOnResize: true },
      localization: { locale: 'zh-CN', priceFormatter: (value: number) => value.toFixed(2) },
    })
    const series = chart.addSeries(AreaSeries, {
      lineColor: '#78aafa', lineWidth: 2, topColor: 'rgba(120,170,250,0.23)', bottomColor: 'rgba(120,170,250,0.01)',
      crosshairMarkerBackgroundColor: '#78aafa', crosshairMarkerBorderColor: '#0f1218',
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 }, pointMarkersVisible: points.length === 1,
    })
    series.setData(points.map((point) => ({ time: point.time as UTCTimestamp, value: point.close })))
    chart.timeScale().fitContent()
    chartRef.current = chart
    const pointsByTime = new Map(points.map((point) => [point.time, point]))
    const onMove = (event: MouseEventParams) => {
      if (!event.point || event.point.x < 0 || event.point.y < 0 || event.point.x > container.clientWidth || event.point.y > container.clientHeight || typeof event.time !== 'number') {
        setTooltip(null)
        return
      }
      const point = pointsByTime.get(event.time)
      setTooltip(point ? { point, x: event.point.x, y: event.point.y } : null)
    }
    chart.subscribeCrosshairMove(onMove)
    const observer = new ResizeObserver(([entry]) => chart.applyOptions({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(container)
    return () => {
      observer.disconnect()
      chart.unsubscribeCrosshairMove(onMove)
      chart.remove()
      chartRef.current = null
      setTooltip(null)
    }
  }, [points])

  return <>
    <div className="chart-shell total-return-chart-shell">
      <div className="chart" ref={containerRef} aria-label={`${name} ${fundCode}红利再投资总回报${period}趋势图`}>
        {!points.length && <div className="chart-empty">当前范围暂无净值数据</div>}
      </div>
      {tooltip && <div className="chart-tooltip" style={{
        left: Math.min(Math.max(tooltip.x + 14, 8), Math.max(8, (containerRef.current?.clientWidth ?? 0) - 196)),
        top: Math.min(Math.max(8, tooltip.y - 100), Math.max(8, (containerRef.current?.clientHeight ?? 0) - 112)),
      }}>
        <div className="chart-tooltip-time">{formatDate(tooltip.point.time)}</div>
        <div className="chart-tooltip-close"><span>总回报指数</span><strong>{tooltip.point.close.toFixed(2)}</strong></div>
        <div className="total-return-tooltip-yield"><span>基准以来收益</span><b>{signed.format((tooltip.point.close / baseValue - 1) * 100)}%</b></div>
      </div>}
    </div>
    <div className="chart-interaction-note"><span>鼠标悬停查看详情 · 滚轮缩放</span><button type="button" onClick={() => chartRef.current?.timeScale().fitContent()}>重置视图</button></div>
  </>
}

export default function EtfTotalReturnPanel({ instrumentKey, fundCode, name, isOffExchange }: { instrumentKey: string; fundCode: string; name: string; isOffExchange: boolean }) {
  const [data, setData] = useState<EtfTotalReturnResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [period, setPeriod] = useState<ReturnPeriod>('MAX')
  const activeRequest = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    setLoading(true)
    const timeout = window.setTimeout(() => controller.abort(), 45_000)
    try {
      const response = await fetch(`/api/etf-total-return?key=${encodeURIComponent(instrumentKey)}`, { signal: controller.signal, cache: 'no-store' })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || '红利再投资数据暂不可用')
      if (body.key !== instrumentKey || body.fundCode !== fundCode || !Array.isArray(body.points) || !body.points.length || !Number.isFinite(body.baseValue) || body.baseValue <= 0 || !Number.isFinite(body.latestValue) || !Number.isFinite(body.totalReturnPercent)
        || body.points.some((point: ChartPoint, index: number) => !Number.isFinite(point.time) || !Number.isFinite(point.close) || point.close <= 0 || (index > 0 && point.time <= body.points[index - 1].time))) {
        throw new Error('红利再投资数据不完整，请稍后重试')
      }
      if (controller !== activeRequest.current) return
      setData(body)
      setError('')
    } catch (reason) {
      if (controller !== activeRequest.current) return
      setError(reason instanceof Error && reason.name !== 'AbortError' ? reason.message : '红利再投资数据请求超时，请重试')
    } finally {
      window.clearTimeout(timeout)
      if (controller === activeRequest.current) setLoading(false)
    }
  }, [instrumentKey, fundCode])

  useEffect(() => {
    setData(null)
    setError('')
    setPeriod('MAX')
    load()
    const timer = window.setInterval(load, 5 * 60_000)
    return () => {
      window.clearInterval(timer)
      activeRequest.current?.abort()
      activeRequest.current = null
    }
  }, [load])

  const points = useMemo(() => {
    if (!data) return []
    if (period === 'MAX') return data.points
    const lastPoint = data.points.at(-1)!
    const cutoff = new Date(lastPoint.time * 1000)
    const months = { '1M': 1, '3M': 3, '1Y': 12, '5Y': 60 }[period]
    const day = cutoff.getUTCDate()
    cutoff.setUTCDate(1)
    cutoff.setUTCMonth(cutoff.getUTCMonth() - months)
    const lastDay = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)).getUTCDate()
    cutoff.setUTCDate(Math.min(day, lastDay))
    return data.points.filter((point) => point.time >= cutoff.getTime() / 1000)
  }, [data, period])

  return <section className="chart-panel total-return-panel" aria-labelledby="total-return-title" aria-busy={loading}>
    <div className="chart-header">
      <div className="chart-title">
        <span className="ticker-icon total-return-icon"><TrendingUp size={18} /></span>
        <div><p>Dividend Reinvestment Total Return</p><h3 id="total-return-title">红利再投资总回报</h3><span className="chart-basis-label">{fundCode} · 每日净值测算 · 起点 = {data?.baseValue ?? 100}</span></div>
      </div>
      <div className="chart-actions">
        <div className="period-control" role="group" aria-label="红利再投资时间范围">
          {periods.map((item) => <button type="button" key={item.value} aria-pressed={period === item.value} className={period === item.value ? 'selected' : ''} onClick={() => setPeriod(item.value)}>{item.label}</button>)}
        </div>
        <button className="icon-button" onClick={load} disabled={loading} title="刷新红利再投资数据" aria-label="刷新红利再投资数据"><RefreshCw size={15} className={loading ? 'spin' : ''} /></button>
      </div>
    </div>
    <div className="chart-meta total-return-meta">
      <div><span>总回报指数</span><strong>{data ? data.latestValue.toFixed(2) : '--'}</strong></div>
      <div><span>基准以来累计收益</span><strong className={data && data.totalReturnPercent < 0 ? 'down' : 'up'}>{data ? `${signed.format(data.totalReturnPercent)}%` : '--'}</strong></div>
      <div><span>最新净值日期</span><strong>{data?.lastDate ?? '--'}</strong></div>
      <div><span>历史起点（= {data?.baseValue ?? 100}）</span><strong>{data?.baseDate ?? '--'}</strong></div>
    </div>
    {data ? <TotalReturnChart points={points} baseValue={data.baseValue} period={period} name={name} fundCode={fundCode} /> : <div className="chart-shell total-return-chart-shell"><div className="chart-empty" role="status"><span>{loading ? '正在加载完整净值与分红历史…' : error || '暂无可用总回报数据'}</span>{!loading && <button className="total-return-retry" onClick={load}>重新加载</button>}</div></div>}
    <div className="total-return-notes">
      {data && (data.isStale || error) && <span className="valuation-warning" role="status">更新暂不可用，显示上次成功数据。{error}</span>}
      <span>分红按除息日净值再投资测算；每日净值披露后更新。{isOffExchange ? '实际账户是否再投资，取决于你选择的分红方式。' : '测算不等于实时场内价格或账户实际收益。'}</span>
      {data && <>
        <details className="total-return-method"><summary>计算口径{data.dividendCount == null ? '' : ` · 已计入 ${data.dividendCount} 次分红`}</summary><p>{data.note || '以前一日总回报值乘以（当日单位净值 + 每份现金分红）÷ 前一日单位净值，首个数据日归一为100。'}</p><p>切换时间范围不会重设基准，100始终对应 {data.baseDate}。</p></details>
        {data.sourceUrl ? <a href={data.sourceUrl} target="_blank" rel="noreferrer">来源：{data.sourceName}</a> : <span>来源：{data.sourceName}</span>}
      </>}
    </div>
  </section>
}
