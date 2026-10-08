import { useEffect, useRef, useState } from 'react'
import {
  AreaSeries,
  ColorType,
  CrosshairMode,
  createChart,
  type IChartApi,
  type MouseEventParams,
  type UTCTimestamp,
} from 'lightweight-charts'
import type { ChartPoint, Market, Period } from './types'
import { formatMarketNumber } from './currency'

interface TrendChartProps {
  market: Market
  period: Period
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

export default function TrendChart({ market, period }: TrendChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container || !market.points.length) return

    const positive = (market.change ?? 0) >= 0
    const lineColor = positive ? '#f05d68' : '#2fc47c'
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
        timeVisible: isIntraday(market, period),
        secondsVisible: false,
        rightOffset: 0,
        minBarSpacing: 0.01,
        lockVisibleTimeRangeOnResize: true,
      },
      localization: {
        locale: 'zh-CN',
        priceFormatter: (price: number) => formatMarketNumber(price, market),
      },
    })
    const series = chart.addSeries(AreaSeries, {
      lineColor,
      lineWidth: 2,
      topColor: positive ? 'rgba(240,93,104,0.25)' : 'rgba(47,196,124,0.28)',
      bottomColor: positive ? 'rgba(240,93,104,0.01)' : 'rgba(47,196,124,0.01)',
      crosshairMarkerBackgroundColor: lineColor,
      crosshairMarkerBorderColor: '#0f1218',
      priceLineVisible: true,
      lastValueVisible: true,
      priceFormat: { type: 'price', precision: market.precision ?? 2, minMove: 10 ** -(market.precision ?? 2) },
      pointMarkersVisible: market.points.length === 1,
    })
    series.setData(market.points.map((point) => ({ time: point.time as UTCTimestamp, value: point.close })))
    chart.timeScale().fitContent()
    const firstPoint = market.points[0]
    const lastPoint = market.points.at(-1)
    if (firstPoint && lastPoint && firstPoint.time < lastPoint.time) {
      chart.timeScale().setVisibleRange({
        from: firstPoint.time as UTCTimestamp,
        to: lastPoint.time as UTCTimestamp,
      })
    }
    chartRef.current = chart

    const pointsByTime = new Map(market.points.map((point) => [point.time, point]))
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
      const point = pointsByTime.get(Number(timestamp))
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
      setTooltip(null)
    }
  }, [market, period])

  return (
    <div className="chart-shell">
      <div className="chart" ref={containerRef} aria-label={`${market.name}${period}趋势图`}>
        {!market.points.length && <div className="chart-empty">当前范围暂无可用历史数据</div>}
      </div>
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
