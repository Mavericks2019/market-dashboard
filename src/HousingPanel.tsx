import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Building2, RefreshCw } from 'lucide-react'
import {
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  createChart,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import type { HousingRecord, HousingResponse } from './types'

type PropertyType = 'newHome' | 'resale'
type HousingMetric = 'yoyIndex' | 'momIndex'
type HousingPeriod = '1Y' | '5Y' | 'MAX'

const propertyLabels: Record<PropertyType, string> = { newHome: '新建商品住宅', resale: '二手住宅' }
const metricLabels: Record<HousingMetric, string> = { yoyIndex: '同比', momIndex: '环比' }
const signed = new Intl.NumberFormat('zh-CN', { signDisplay: 'always', minimumFractionDigits: 1, maximumFractionDigits: 1 })

function change(index: number | null | undefined) {
  return index != null && Number.isFinite(index) && index > 0 ? Number((index - 100).toFixed(1)) : null
}

function changeText(index: number | null | undefined) {
  const value = change(index)
  return value == null ? '暂无' : `${signed.format(value)}%`
}

function monthText(month: string) {
  return `${month.slice(0, 4)}年${Number(month.slice(5, 7))}月`
}

function monthNumber(month: string) {
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1
}

function monthTimestamp(month: string) {
  return Math.floor(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1) / 1000) as UTCTimestamp
}

function timeMonth(time: Time) {
  if (typeof time === 'number') return new Date(time * 1000).toISOString().slice(0, 7)
  if (typeof time === 'string') return time.slice(0, 7)
  return `${time.year}-${String(time.month).padStart(2, '0')}`
}

function HousingChart({ records, property, metric, city }: {
  records: HousingRecord[]
  property: PropertyType
  metric: HousingMetric
  city: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [tooltip, setTooltip] = useState<{ record: HousingRecord; x: number; y: number } | null>(null)
  const hasValues = records.some((record) => change(record[property][metric]) != null)

  useEffect(() => {
    const container = containerRef.current
    if (!container || !hasValues) return

    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#77808f',
        fontFamily: 'Inter, "Microsoft YaHei", sans-serif',
        fontSize: 11,
      },
      grid: { vertLines: { color: 'rgba(255,255,255,0.035)' }, horzLines: { color: 'rgba(255,255,255,0.05)' } },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#697386', labelBackgroundColor: '#343a45' },
        horzLine: { color: '#697386', labelBackgroundColor: '#343a45' },
      },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)', scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.08)',
        timeVisible: false,
        rightOffset: 0,
        minBarSpacing: 0.01,
        lockVisibleTimeRangeOnResize: true,
        tickMarkFormatter: (time: Time) => timeMonth(time),
      },
      localization: {
        locale: 'zh-CN',
        priceFormatter: (price: number) => `${signed.format(price)}%`,
        timeFormatter: (time: Time) => monthText(timeMonth(time)),
      },
    })
    const color = property === 'newHome' ? '#5aacf0' : '#b291eb'
    const seriesOptions = {
      color,
      lineWidth: 2 as const,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerBackgroundColor: color,
      crosshairMarkerBorderColor: '#0f1218',
      priceFormat: { type: 'custom' as const, formatter: (price: number) => `${signed.format(price)}%`, minMove: 0.1 },
    }

    // The empty series keeps all supplied months on the time axis, including gaps.
    const calendar = chart.addSeries(LineSeries, seriesOptions)
    calendar.setData(records.map((record) => ({ time: monthTimestamp(record.month) })))
    calendar.createPriceLine({ price: 0, color: '#536071', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false })

    // A separate line for each uninterrupted run prevents missing months being joined.
    const segments: Array<Array<{ time: UTCTimestamp; value: number }>> = []
    let previousMonth: number | null = null
    let segment: Array<{ time: UTCTimestamp; value: number }> = []
    for (const record of records) {
      const value = change(record[property][metric])
      const currentMonth = monthNumber(record.month)
      if (value == null || (previousMonth != null && currentMonth !== previousMonth + 1)) {
        if (segment.length) segments.push(segment)
        segment = []
      }
      if (value != null) segment.push({ time: monthTimestamp(record.month), value })
      previousMonth = currentMonth
    }
    if (segment.length) segments.push(segment)
    for (const points of segments) {
      chart.addSeries(LineSeries, { ...seriesOptions, pointMarkersVisible: points.length === 1 }).setData(points)
    }
    chart.timeScale().fitContent()

    const recordsByTime = new Map(records.map((record) => [monthTimestamp(record.month), record]))
    const onMove = (event: MouseEventParams) => {
      if (!event.point || event.point.x < 0 || event.point.y < 0 || event.point.x > container.clientWidth || event.point.y > container.clientHeight || typeof event.time !== 'number') {
        setTooltip(null)
        return
      }
      const record = recordsByTime.get(event.time as UTCTimestamp)
      setTooltip(record ? { record, x: event.point.x, y: event.point.y } : null)
    }
    chart.subscribeCrosshairMove(onMove)
    const observer = new ResizeObserver(([entry]) => chart.applyOptions({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(container)
    return () => {
      observer.disconnect()
      chart.unsubscribeCrosshairMove(onMove)
      chart.remove()
      setTooltip(null)
    }
  }, [records, property, metric, hasValues])

  return <div className="housing-chart-shell">
    <div className="housing-chart" ref={containerRef} aria-label={`${city}${propertyLabels[property]}${metricLabels[metric]}月度趋势图`}>
      {!hasValues && <div className="chart-empty">当前范围暂无可用住宅价格数据</div>}
    </div>
    {tooltip && <div className="chart-tooltip housing-tooltip" style={{
      left: Math.min(Math.max(tooltip.x + 14, 8), Math.max(8, (containerRef.current?.clientWidth ?? 0) - 196)),
      top: Math.min(Math.max(8, tooltip.y - 118), Math.max(8, (containerRef.current?.clientHeight ?? 0) - 150)),
    }}>
      <div className="chart-tooltip-time">{city} · {monthText(tooltip.record.month)}</div>
      <div className="chart-tooltip-close"><span>{metricLabels[metric]}涨跌幅</span><strong>{changeText(tooltip.record[property][metric])}</strong></div>
      <div className="housing-tooltip-details">
        <span>环比 <b>{changeText(tooltip.record[property].momIndex)}</b></span>
        <span>同比 <b>{changeText(tooltip.record[property].yoyIndex)}</b></span>
        <span>官方{metricLabels[metric]}指数 <b>{tooltip.record[property][metric]?.toFixed(1) ?? '暂无'}</b></span>
      </div>
    </div>}
  </div>
}

export default function HousingPanel() {
  const [data, setData] = useState<HousingResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [cityId, setCityId] = useState('')
  const [property, setProperty] = useState<PropertyType>('newHome')
  const [metric, setMetric] = useState<HousingMetric>('yoyIndex')
  const [period, setPeriod] = useState<HousingPeriod>('MAX')
  const activeRequest = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    setLoading(true)
    const timeout = window.setTimeout(() => controller.abort(), 30_000)
    try {
      const response = await fetch('/api/housing', { signal: controller.signal, cache: 'no-store' })
      const body = await response.json()
      if (!response.ok || !Array.isArray(body.cities) || !body.cities.length) throw new Error(body.error || '住宅价格数据暂不可用')
      if (controller !== activeRequest.current) return
      setData(body)
      setError('')
    } catch (reason) {
      if (controller !== activeRequest.current) return
      setError(reason instanceof Error && reason.name !== 'AbortError' ? reason.message : '住宅价格数据请求超时，稍后重试')
    } finally {
      window.clearTimeout(timeout)
      if (controller === activeRequest.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const timer = window.setInterval(load, 6 * 60 * 60_000)
    return () => {
      window.clearInterval(timer)
      activeRequest.current?.abort()
      activeRequest.current = null
    }
  }, [load])

  const city = data?.cities.find((item) => item.id === cityId) ?? data?.cities.find((item) => item.name === '北京') ?? data?.cities[0]
  const records = useMemo(() => {
    if (!city) return []
    const unique = new Map(city.records.filter((record) => /^\d{4}-(0[1-9]|1[0-2])$/.test(record.month)).map((record) => [record.month, record]))
    return [...unique.values()].sort((a, b) => a.month.localeCompare(b.month))
  }, [city])
  const latest = records.at(-1)
  const visibleRecords = useMemo(() => {
    if (period === 'MAX' || !latest) return records
    const firstMonth = monthNumber(latest.month) - (period === '1Y' ? 11 : 59)
    return records.filter((record) => monthNumber(record.month) >= firstMonth)
  }, [records, latest, period])
  const latestPrices = latest?.[property]
  const latestValue = change(latestPrices?.[metric])

  return <section className="housing-panel" aria-labelledby="housing-title" aria-busy={loading}>
    <div className="section-heading housing-heading">
      <div><p className="eyebrow">CHINA HOUSING</p><h2 id="housing-title">房地产</h2></div>
      <div className="housing-refresh">
        <span>{loading ? '正在更新…' : '月度发布 · 每6小时检查'}</span>
        <button className="icon-button" onClick={load} disabled={loading} aria-label="刷新住宅价格" title="刷新住宅价格"><RefreshCw size={16} className={loading ? 'spin' : ''} /></button>
      </div>
    </div>
    <p className="housing-intro">中国住宅价格 · 国家统计局70个大中城市住宅销售价格指数 · 按城市查看，不代表全国平均房价</p>
    {error && <p className="valuation-warning" role="status">{error}{data ? '，保留上次结果。' : '。'}</p>}
    {data?.isStale && <p className="valuation-warning" role="status">本次更新暂不可用，显示已保存的月度数据。</p>}

    <div className="housing-controls">
      <label className="housing-city-label">城市<select aria-label="住宅价格城市" value={city?.id ?? ''} onChange={(event) => setCityId(event.target.value)} disabled={!data}>
        {!data && <option value="">{loading ? '正在加载城市…' : '暂无可用城市'}</option>}
        {data?.cities.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <div className="period-control housing-property-control" role="group" aria-label="住宅类型">
        {(['newHome', 'resale'] as const).map((value) => <button key={value} className={property === value ? 'selected' : ''} aria-pressed={property === value} onClick={() => setProperty(value)}>{value === 'newHome' ? '新房' : '二手房'}</button>)}
      </div>
      <div className="housing-release"><Building2 size={14} /><span>{data ? `最新统计 ${monthText(data.latestMonth)}` : '等待月度数据'}</span></div>
    </div>

    <div className="housing-stats">
      {(['yoyIndex', 'momIndex'] as const).map((value) => {
        const rate = change(latestPrices?.[value])
        return <button key={value} className={`housing-stat ${metric === value ? 'selected' : ''}`} aria-pressed={metric === value} onClick={() => setMetric(value)}>
          <span>{city?.name ?? '城市'} · {propertyLabels[property]} · {metricLabels[value]}</span>
          <strong className={rate == null || rate === 0 ? '' : rate > 0 ? 'up' : 'down'}>{changeText(latestPrices?.[value])}</strong>
          <small>{latest ? monthText(latest.month) : loading ? '正在加载…' : '暂无数据'} · 官方指数 {latestPrices?.[value]?.toFixed(1) ?? '暂无'}{value === 'yoyIndex' ? '（上年同月=100）' : '（上月=100）'}</small>
        </button>
      })}
    </div>

    <div className="housing-chart-header">
      <div><h3>{city?.name ?? '城市'}{propertyLabels[property]} · {metricLabels[metric]}涨跌幅</h3><p>{visibleRecords.length ? `${visibleRecords[0].month} — ${visibleRecords.at(-1)?.month} · 月度数据` : '等待历史数据'}{latestValue == null ? '' : ' · 鼠标悬停查看详情'}</p></div>
      <div className="period-control" role="group" aria-label="住宅价格历史范围">
        {([{ value: '1Y', label: '1年' }, { value: '5Y', label: '5年' }, { value: 'MAX', label: '全部历史' }] as const).map((item) => <button key={item.value} className={period === item.value ? 'selected' : ''} aria-pressed={period === item.value} onClick={() => setPeriod(item.value)}>{item.label}</button>)}
      </div>
    </div>
    <HousingChart records={visibleRecords} property={property} metric={metric} city={city?.name ?? ''} />
    <div className="housing-notes">
      <span>涨跌幅 = 官方指数 − 100；同比比较上年同月，环比比较上月。图表默认展示全部可用历史；缺失月份不连线，不表示房价为零。</span>
      {data?.note && <span>{data.note}</span>}
      {data?.sourceUrl && <a href={data.sourceUrl} target="_blank" rel="noreferrer">{data.sourceName || '国家统计局'} · 查看数据来源</a>}
      <a href="https://www.stats.gov.cn/zs/tjws/zytjzbqs/zzxsjgzs/202411/t20241128_1957596.html" target="_blank" rel="noreferrer">国家统计局 · 统计口径说明</a>
    </div>
  </section>
}
