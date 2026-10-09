import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Maximize2 } from 'lucide-react'
import { ColorType, CrosshairMode, HistogramSeries, LineStyle, createChart, type IChartApi, type MouseEventParams, type Time, type UTCTimestamp } from 'lightweight-charts'

export type AnnualInvestmentRecord = {
  year: number
  amount: number | null
  yoy: number | null
  releaseDate?: string
  sourceUrl?: string
}

type Metric = 'yoy' | 'amount'
const amounts = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 })
const growth = new Intl.NumberFormat('zh-CN', { signDisplay: 'always', minimumFractionDigits: 1, maximumFractionDigits: 1 })
const riseColor = '#f06470'
const fallColor = '#31c981'

function annualValue(value: number | null | undefined, metric: Metric) {
  return value == null || !Number.isFinite(value) ? '暂无' : metric === 'yoy' ? `${growth.format(value)}%` : `${amounts.format(value)} 亿元`
}

function yearTimestamp(year: number) {
  return Math.floor(Date.UTC(year, 0, 1) / 1000) as UTCTimestamp
}

function timeYear(time: Time) {
  return typeof time === 'number' ? String(new Date(time * 1000).getUTCFullYear()) : typeof time === 'string' ? time.slice(0, 4) : String(time.year)
}

const AnnualChart = memo(function AnnualChart({ records, metric, resetToken, onSelect }: {
  records: AnnualInvestmentRecord[]
  metric: Metric
  resetToken: number
  onSelect: (year: number) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [tooltip, setTooltip] = useState<{ record: AnnualInvestmentRecord; x: number; y: number } | null>(null)
  const [error, setError] = useState('')
  const hasValues = records.some((record) => record[metric] != null)

  useEffect(() => {
    setTooltip(null)
    setError('')
    const container = containerRef.current
    if (!container || !hasValues) return
    let chart: IChartApi | null = null
    let observer: ResizeObserver | null = null
    let onMove: ((event: MouseEventParams) => void) | null = null
    let onClick: ((event: MouseEventParams) => void) | null = null
    try {
      chart = createChart(container, {
        width: Math.max(1, container.clientWidth),
        height: Math.max(1, container.clientHeight),
        layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#8491a3', fontFamily: 'Inter, "Microsoft YaHei", sans-serif', fontSize: 11 },
        grid: { vertLines: { color: 'rgba(255,255,255,0.035)' }, horzLines: { color: 'rgba(255,255,255,0.05)' } },
        crosshair: { mode: CrosshairMode.Normal, vertLine: { color: '#697386', labelBackgroundColor: '#343a45' }, horzLine: { color: '#697386', labelBackgroundColor: '#343a45' } },
        rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)', scaleMargins: { top: 0.12, bottom: 0.12 } },
        timeScale: { borderColor: 'rgba(255,255,255,0.08)', rightOffset: 0.35, minBarSpacing: 0.01, lockVisibleTimeRangeOnResize: true, tickMarkFormatter: (time: Time) => timeYear(time) },
        localization: { locale: 'zh-CN', timeFormatter: (time: Time) => `${timeYear(time)}年全年`, priceFormatter: (value: number) => annualValue(value, metric) },
      })
      const series = chart.addSeries(HistogramSeries, {
        priceLineVisible: false,
        lastValueVisible: false,
        priceFormat: { type: 'custom', formatter: (value: number) => metric === 'yoy' ? `${growth.format(value)}%` : `${amounts.format(value)} 亿`, minMove: 0.1 },
      })
      series.setData(records.map((record) => record[metric] == null
        ? { time: yearTimestamp(record.year) }
        : { time: yearTimestamp(record.year), value: record[metric]!, color: metric === 'amount' ? '#86a9cc' : record.yoy! > 0 ? riseColor : record.yoy! < 0 ? fallColor : '#8a97a7' }))
      series.createPriceLine({ price: 0, color: '#7e8998', lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: metric === 'yoy' ? '0%' : '' })
      chart.timeScale().fitContent()
      const recordsByTime = new Map(records.map((record) => [yearTimestamp(record.year), record]))
      onMove = (event) => {
        if (!event.point || typeof event.time !== 'number' || event.point.x < 0 || event.point.y < 0 || event.point.x > container.clientWidth || event.point.y > container.clientHeight) {
          setTooltip(null)
          return
        }
        const record = recordsByTime.get(event.time as UTCTimestamp)
        setTooltip(record ? { record, x: event.point.x, y: event.point.y } : null)
        if (record) onSelect(record.year)
      }
      onClick = (event) => {
        if (typeof event.time !== 'number') return
        const record = recordsByTime.get(event.time as UTCTimestamp)
        if (record) onSelect(record.year)
      }
      chart.subscribeCrosshairMove(onMove)
      chart.subscribeClick(onClick)
      const liveChart = chart
      observer = new ResizeObserver(([entry]) => {
        if (entry.contentRect.width > 0 && entry.contentRect.height > 0) liveChart.applyOptions({ width: entry.contentRect.width, height: entry.contentRect.height })
      })
      observer.observe(container)
    } catch {
      setError('年度图表暂时无法绘制，可切换指标或重置缩放重试。')
    }
    return () => {
      observer?.disconnect()
      if (chart && onMove) chart.unsubscribeCrosshairMove(onMove)
      if (chart && onClick) chart.unsubscribeClick(onClick)
      chart?.remove()
    }
  }, [records, metric, resetToken, onSelect, hasValues])

  return <div className="investment-chart-shell investment-annual-chart-shell">
    <div className="investment-chart" ref={containerRef} aria-label={`全国固定资产投资${metric === 'yoy' ? '全年同比' : '全年投资额'}年度趋势图`} />
    {(!hasValues || error) && <div className="investment-chart-empty" role="status">{error || '等待官方全年数据，暂无可用年度记录'}</div>}
    {tooltip && <div className="investment-tooltip investment-annual-tooltip" style={{
      left: Math.min(Math.max(tooltip.x + 14, 8), Math.max(8, (containerRef.current?.clientWidth ?? 0) - 245)),
      top: Math.min(Math.max(8, tooltip.y - 135), Math.max(8, (containerRef.current?.clientHeight ?? 0) - 145)),
    }}>
      <p>{tooltip.record.year}年全年 · 全国</p>
      <div><span>全年投资额</span><strong>{annualValue(tooltip.record.amount, 'amount')}</strong></div>
      <div><span>官方全年同比</span><strong className={tooltip.record.yoy == null || tooltip.record.yoy === 0 ? '' : tooltip.record.yoy > 0 ? 'up' : 'down'}>{annualValue(tooltip.record.yoy, 'yoy')}</strong></div>
      <small>官方发布来源见下方年度详情</small>
    </div>}
  </div>
})

const AnnualInvestmentPanel = memo(function AnnualInvestmentPanel({ records, currentPeriod }: {
  records: AnnualInvestmentRecord[]
  currentPeriod: { month: string; yoy: number | null } | undefined
}) {
  const [metric, setMetric] = useState<Metric>('yoy')
  const [resetToken, setResetToken] = useState(0)
  const [selectedYear, setSelectedYear] = useState<number | null>(null)
  const selectYear = useCallback((year: number) => setSelectedYear(year), [])
  const selected = records.find((record) => record.year === selectedYear) ?? records.at(-1)
  const summary = useMemo(() => {
    return {
      rises: records.filter((record) => record.yoy != null && record.yoy > 0).map((record) => record.year),
      falls: records.filter((record) => record.yoy != null && record.yoy < 0).map((record) => record.year),
      flat: records.filter((record) => record.yoy === 0).map((record) => record.year),
      missing: records.filter((record) => record.yoy == null).map((record) => record.year),
    }
  }, [records])
  const yearList = (years: number[]) => years.length ? years.join('、') : records.length ? '暂无已公布年份' : '等待全年数据'
  const currentEndMonth = currentPeriod ? Number(currentPeriod.month.slice(5, 7)) : 12

  return <section className="investment-annual-panel" aria-labelledby="annual-investment-title">
    <div className="investment-chart-header investment-annual-heading">
      <div><h3 id="annual-investment-title">年度投资趋势 <span>/ Annual Investment Trend</span></h3><p>{records.length ? `${records[0].year} — ${records.at(-1)?.year} · ${records.length}个完整年份` : '等待官方全年数据'} · {metric === 'yoy' ? '官方全年同比（%）· 红涨绿跌' : '全年投资额（亿元）'} · 悬停查看每年详情</p></div>
      <div className="investment-chart-actions">
        <div className="period-control" role="group" aria-label="年度投资趋势指标">{([{ value: 'yoy', label: '全年同比' }, { value: 'amount', label: '全年投资额' }] as const).map((item) => <button key={item.value} className={metric === item.value ? 'selected' : ''} aria-pressed={metric === item.value} onClick={() => setMetric(item.value)}>{item.label}</button>)}</div>
        <button className="icon-button" aria-label="重置年度投资图表缩放" title="显示全部年度数据" onClick={() => setResetToken((value) => value + 1)}><Maximize2 size={15} /></button>
      </div>
    </div>
    <AnnualChart records={records} metric={metric} resetToken={resetToken} onSelect={selectYear} />
    <div className="investment-annual-detail">
      <label>年度详情<select aria-label="年度投资详情年份" value={selected?.year ?? ''} onChange={(event) => selectYear(Number(event.target.value))} disabled={!records.length}>
        {!records.length && <option value="">等待数据</option>}
        {records.map((record) => <option key={record.year} value={record.year}>{record.year}年</option>)}
      </select></label>
      <span>全年投资额 <b>{annualValue(selected?.amount, 'amount')}</b></span>
      <span>官方全年同比 <b className={selected?.yoy == null || selected.yoy === 0 ? '' : selected.yoy > 0 ? 'up' : 'down'}>{annualValue(selected?.yoy, 'yoy')}</b></span>
      {selected?.releaseDate && <span>公布 {selected.releaseDate}</span>}
      {selected?.sourceUrl && <a href={selected.sourceUrl} target="_blank" rel="noreferrer">{selected.year}年 · 官方发布 ↗</a>}
    </div>
    <div className="investment-year-summary">
      <p><span className="up">上涨年份</span><strong>{yearList(summary.rises)}</strong></p>
      <p><span className="down">下降年份</span><strong>{yearList(summary.falls)}</strong></p>
      {summary.flat.length > 0 && <p><span>持平年份</span><strong>{yearList(summary.flat)}</strong></p>}
    </div>
    {summary.missing.length > 0 && <p className="investment-warning">{yearList(summary.missing)}年尚未取得官方全年同比，未参与涨跌分类。</p>}
    {currentPeriod && currentEndMonth < 12 && !records.some((record) => record.year === Number(currentPeriod.month.slice(0, 4))) && <p className="investment-current-year"><span>{currentPeriod.month.slice(0, 4)}年1—{currentEndMonth}月</span><strong className={currentPeriod.yoy == null || currentPeriod.yoy === 0 ? '' : currentPeriod.yoy > 0 ? 'up' : 'down'}>{annualValue(currentPeriod.yoy, 'yoy')}</strong><span>尚非全年，未并入年度图</span></p>}
    <p className="investment-annual-note">涨跌按官方全年同比分类；统计范围与基数可能修订，不能用相邻年份金额直接反推同比。</p>
  </section>
})

export default AnnualInvestmentPanel
