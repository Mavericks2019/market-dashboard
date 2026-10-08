import { memo, useEffect, useRef, useState } from 'react'
import {
  AreaSeries,
  ColorType,
  CrosshairMode,
  createChart,
  type IChartApi,
  type IRange,
  type ISeriesApi,
  type LogicalRange,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import type { ChartPoint, Market, Period } from './types'
import { formatMarketNumber } from './currency'

interface TrendChartProps {
  market: Market
  period: Period
  loading?: boolean
}

interface TooltipState {
  point: ChartPoint
  x: number
  y: number
}

function isIntraday(market: Market, period: Period) {
  return (period === '1D' || period === '5D') && (/^\d+[mh]$/.test(market.dataGranularity) || market.dataGranularity === 'quote')
}

function formatTooltipTime(timestamp: number, market: Market, period: Period) {
  const timeZone = market.exchangeTimezone || 'Asia/Shanghai'
  const options: Intl.DateTimeFormatOptions = isIntraday(market, period)
    ? { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }
  try {
    return new Intl.DateTimeFormat('zh-CN', options).format(new Date(timestamp * 1000))
  } catch {
    return new Intl.DateTimeFormat('zh-CN', { ...options, timeZone: 'UTC' }).format(new Date(timestamp * 1000))
  }
}

function formatTooltipNumber(value: number | null, market: Market) {
  if (value == null || !Number.isFinite(value)) return '--'
  return `${formatMarketNumber(value, market)}${market.unit ? ` ${market.unit}` : ''}`
}

function TrendChart({ market, period, loading = false }: TrendChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null)
  const currentMarketRef = useRef(market)
  const pointsByTimeRef = useRef(new Map<number, ChartPoint>())
  const appliedPointsRef = useRef<ChartPoint[]>([])
  const fittedRef = useRef(false)
  const viewportRef = useRef<{ logical: LogicalRange | null; time: IRange<Time> | null } | null>(null)
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  currentMarketRef.current = market
  const positive = (market.change ?? 0) >= 0
  const intraday = isIntraday(market, period)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    fittedRef.current = false
    appliedPointsRef.current = []
    pointsByTimeRef.current = new Map()
    viewportRef.current = null
    setTooltip(null)
    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#77808f',
        fontFamily: 'Inter, "Microsoft YaHei", sans-serif',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.035)' },
        horzLines: { color: 'rgba(255,255,255,0.05)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#697386', labelBackgroundColor: '#343a45' },
        horzLine: { color: '#697386', labelBackgroundColor: '#343a45' },
      },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)', scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.08)',
        timeVisible: isIntraday(currentMarketRef.current, period),
        secondsVisible: false,
        rightOffset: 0,
        minBarSpacing: 0.01,
        lockVisibleTimeRangeOnResize: true,
        shiftVisibleRangeOnNewBar: false,
      },
      localization: {
        locale: 'zh-CN',
        priceFormatter: (price: number) => formatMarketNumber(price, currentMarketRef.current),
      },
    })
    const series = chart.addSeries(AreaSeries, {
      lineWidth: 2,
      crosshairMarkerBorderColor: '#0f1218',
      priceLineVisible: true,
      lastValueVisible: true,
    })
    chartRef.current = chart
    seriesRef.current = series

    const handleCrosshairMove = (param: MouseEventParams) => {
      if (!param.point || param.point.x < 0 || param.point.y < 0 || param.point.x > container.clientWidth || param.point.y > container.clientHeight) {
        setTooltip(null)
        return
      }
      const seriesPoint = param.seriesData.get(series) as { time?: UTCTimestamp; value?: number } | undefined
      const timestamp = seriesPoint?.time
      if (timestamp == null) {
        setTooltip(null)
        return
      }
      const point = pointsByTimeRef.current.get(Number(timestamp))
      if (!point) {
        setTooltip(null)
        return
      }
      setTooltip({ point, x: param.point.x, y: param.point.y })
    }
    chart.subscribeCrosshairMove(handleCrosshairMove)

    const resizeObserver = new ResizeObserver(([entry]) => {
      chart.applyOptions({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
      chart.unsubscribeCrosshairMove(handleCrosshairMove)
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
    }
  }, [market.key, period, market.unit])

  useEffect(() => {
    const precision = market.precision ?? 2
    const lineColor = positive ? '#f05d68' : '#2fc47c'
    seriesRef.current?.applyOptions({
      lineColor,
      topColor: positive ? 'rgba(240,93,104,0.25)' : 'rgba(47,196,124,0.28)',
      bottomColor: positive ? 'rgba(240,93,104,0.01)' : 'rgba(47,196,124,0.01)',
      crosshairMarkerBackgroundColor: lineColor,
      priceFormat: { type: 'price', precision, minMove: 10 ** -precision },
    })
    chartRef.current?.applyOptions({ timeScale: { timeVisible: intraday } })
  }, [market.key, period, market.unit, market.precision, positive, intraday])

  useEffect(() => {
    const chart = chartRef.current
    const series = seriesRef.current
    if (!chart || !series) return
    const points = market.points
    const previous = appliedPointsRef.current
    const timeScale = chart.timeScale()

    if (points !== previous) {
      // Live polls usually change only the final bar or append new bars. Keep
      // the existing series and avoid reloading decades of unchanged history.
      const canUpdate = previous.length > 0 && points.length >= previous.length
        && points[previous.length - 1].time === previous[previous.length - 1].time
        && previous.slice(0, -1).every((point, index) => point.time === points[index].time && point.close === points[index].close)
      if (fittedRef.current) {
        const logical = timeScale.getVisibleLogicalRange()
        const time = timeScale.getVisibleRange()
        if (logical || time) viewportRef.current = { logical, time }
      }
      if (canUpdate) {
        for (let index = previous.length - 1; index < points.length; index++) {
          const point = points[index]
          if (index >= previous.length || point.close !== previous[index].close) {
            series.update({ time: point.time as UTCTimestamp, value: point.close })
          }
        }
      } else {
        series.setData(points.map((point) => ({ time: point.time as UTCTimestamp, value: point.close })))
      }
      series.applyOptions({ pointMarkersVisible: points.length === 1 })
      appliedPointsRef.current = points
      pointsByTimeRef.current = new Map(points.map((point) => [point.time, point]))
      setTooltip((current) => {
        if (!current) return null
        const point = pointsByTimeRef.current.get(current.point.time)
        return point ? (point === current.point ? current : { ...current, point }) : null
      })
      const viewport = viewportRef.current
      if (fittedRef.current && points.length && viewport) {
        if (canUpdate && viewport.logical) timeScale.setVisibleLogicalRange(viewport.logical)
        else if (viewport.time) timeScale.setVisibleRange(viewport.time)
      }
    }

    // Wait for the initial history request to finish, then show its entire
    // range once. Subsequent quote/history refreshes keep the user's viewport.
    if (!loading && points.length && !fittedRef.current) {
      timeScale.fitContent()
      const first = points[0]
      const last = points[points.length - 1]
      if (first.time < last.time) timeScale.setVisibleRange({ from: first.time as UTCTimestamp, to: last.time as UTCTimestamp })
      fittedRef.current = true
    }
  }, [market.key, period, market.unit, market.points, loading])

  return (
    <div className="chart-shell">
      <div className="chart" ref={containerRef} aria-label={`${market.name}${period}趋势图`} />
      {!market.points.length && <div className="chart-empty" role="status" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        {loading ? '正在加载历史数据…' : '当前范围暂无可用历史数据'}
      </div>}
      {tooltip && (
        <div
          className="chart-tooltip"
          style={{
            left: Math.min(Math.max(tooltip.x + 14, 8), Math.max(8, (containerRef.current?.clientWidth ?? 0) - 196)),
            top: Math.max(8, tooltip.y - 112),
          }}
        >
          <div className="chart-tooltip-time">{formatTooltipTime(tooltip.point.time, market, period)}</div>
          <div className="chart-tooltip-close">
            <span>{market.key === 'CFETS' ? '指数' : market.kind === 'fund' ? '单位净值' : market.kind === 'forex' ? '汇率' : '收盘'}</span>
            <strong>{formatTooltipNumber(tooltip.point.close, market)}</strong>
          </div>
          {market.key !== 'CFETS' && market.kind !== 'fund' && <div className="chart-tooltip-grid">
            <span>开盘 <b>{formatTooltipNumber(tooltip.point.open, market)}</b></span>
            <span>最高 <b>{formatTooltipNumber(tooltip.point.high, market)}</b></span>
            <span>最低 <b>{formatTooltipNumber(tooltip.point.low, market)}</b></span>
            <span>成交量 <b>{tooltip.point.volume == null ? '--' : tooltip.point.volume.toLocaleString('en-US')}</b></span>
          </div>}
        </div>
      )}
    </div>
  )
}

export default memo(TrendChart)
