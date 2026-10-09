import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Maximize2, RefreshCw } from 'lucide-react'
import {
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import './fixedInvestment.css'
import AnnualInvestmentPanel, { type AnnualInvestmentRecord } from './AnnualInvestmentChart'

type InvestmentRecord = { month: string; amount: number | null; yoy: number | null }
type InvestmentResponse = {
  asOf: number
  latestMonth: string
  historyStart: string
  sourceName: string
  sourceUrl: string
  frequency: string
  isStale: boolean
  note: string
  records: InvestmentRecord[]
  annualRecords: AnnualInvestmentRecord[]
  releaseDate?: string
  releaseSourceUrl?: string
}
type InvestmentMetric = 'yoy' | 'amount'
type InvestmentPeriod = '1Y' | '5Y' | 'MAX'

const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/
const amountFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 })
const trillionFormat = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const growthFormat = new Intl.NumberFormat('zh-CN', { signDisplay: 'always', minimumFractionDigits: 1, maximumFractionDigits: 1 })
const fetchTimeFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })

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

function cumulativePeriod(month: string) {
  const endMonth = Number(month.slice(5, 7))
  return `${month.slice(0, 4)}年1${endMonth === 1 ? '' : `—${endMonth}`}月`
}

function valueText(value: number | null | undefined, metric: InvestmentMetric) {
  if (value == null || !Number.isFinite(value)) return '暂无'
  return metric === 'yoy' ? `${growthFormat.format(value)}%` : `${amountFormat.format(value)} 亿元`
}

function headlineAmount(value: number | null | undefined) {
  return value != null && value >= 10_000 ? `${trillionFormat.format(value / 10_000)} 万亿元` : valueText(value, 'amount')
}

function normalizeRecords(records: InvestmentRecord[]) {
  const unique = new Map<string, InvestmentRecord>()
  for (const record of records) {
    if (!record || typeof record.month !== 'string' || !monthPattern.test(record.month)) continue
    unique.set(record.month, {
      month: record.month,
      amount: typeof record.amount === 'number' && Number.isFinite(record.amount) && record.amount >= 0 ? record.amount : null,
      yoy: typeof record.yoy === 'number' && Number.isFinite(record.yoy) ? record.yoy : null,
    })
  }
  return [...unique.values()].sort((a, b) => a.month.localeCompare(b.month))
}

function sameRecords(previous: InvestmentRecord[] | undefined, next: InvestmentRecord[]) {
  return previous?.length === next.length && previous.every((record, index) => record.month === next[index].month && record.amount === next[index].amount && record.yoy === next[index].yoy)
}

function normalizeAnnualRecords(records: AnnualInvestmentRecord[]) {
  // A verified annual release can arrive before the monthly amount feed catches up.
  const lastFullYear = new Date(Date.now() + 8 * 60 * 60_000).getUTCFullYear() - 1
  const unique = new Map<number, AnnualInvestmentRecord>()
  for (const record of records) {
    if (!record || !Number.isInteger(record.year) || record.year < 1900 || record.year > lastFullYear) continue
    unique.set(record.year, {
      year: record.year,
      amount: typeof record.amount === 'number' && Number.isFinite(record.amount) && record.amount >= 0 ? record.amount : null,
      yoy: typeof record.yoy === 'number' && Number.isFinite(record.yoy) ? record.yoy : null,
      releaseDate: typeof record.releaseDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(record.releaseDate) ? record.releaseDate : undefined,
      sourceUrl: typeof record.sourceUrl === 'string' && /^https?:\/\//.test(record.sourceUrl) ? record.sourceUrl : undefined,
    })
  }
  return [...unique.values()].sort((a, b) => a.year - b.year)
}

function sameAnnualRecords(previous: AnnualInvestmentRecord[] | undefined, next: AnnualInvestmentRecord[]) {
  return previous?.length === next.length && previous.every((record, index) => record.year === next[index].year && record.amount === next[index].amount && record.yoy === next[index].yoy && record.releaseDate === next[index].releaseDate && record.sourceUrl === next[index].sourceUrl)
}

const InvestmentChart = memo(function InvestmentChart({ records, metric, resetToken }: {
  records: InvestmentRecord[]
  metric: InvestmentMetric
  resetToken: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [tooltip, setTooltip] = useState<{ record: InvestmentRecord; x: number; y: number } | null>(null)
  const [chartError, setChartError] = useState('')
  const hasValues = records.some((record) => record[metric] != null)

  useEffect(() => {
    setTooltip(null)
    setChartError('')
    const container = containerRef.current
    if (!container || !hasValues) return
    let chart: IChartApi | null = null
    let observer: ResizeObserver | null = null
    let onMove: ((event: MouseEventParams) => void) | null = null
    try {
      chart = createChart(container, {
        width: Math.max(1, container.clientWidth),
        height: Math.max(1, container.clientHeight),
        layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#8491a3', fontFamily: 'Inter, "Microsoft YaHei", sans-serif', fontSize: 11 },
        grid: { vertLines: { color: 'rgba(255,255,255,0.035)' }, horzLines: { color: 'rgba(255,255,255,0.05)' } },
        crosshair: { mode: CrosshairMode.Normal, vertLine: { color: '#697386', labelBackgroundColor: '#343a45' }, horzLine: { color: '#697386', labelBackgroundColor: '#343a45' } },
        rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)', scaleMargins: { top: 0.12, bottom: 0.08 } },
        timeScale: { borderColor: 'rgba(255,255,255,0.08)', rightOffset: 0, minBarSpacing: 0.01, lockVisibleTimeRangeOnResize: true, tickMarkFormatter: (time: Time) => timeMonth(time) },
        localization: { locale: 'zh-CN', timeFormatter: (time: Time) => cumulativePeriod(timeMonth(time)), priceFormatter: (value: number) => valueText(value, metric) },
      })
      if (metric === 'amount') {
        const amounts = chart.addSeries(HistogramSeries, {
          priceLineVisible: false,
          lastValueVisible: false,
          priceFormat: { type: 'custom', formatter: (value: number) => `${amountFormat.format(value)} 亿`, minMove: 0.1 },
        })
        // Cumulative totals reset each January; bars never join two years into a false drop.
        amounts.setData(records.map((record) => record.amount == null
          ? { time: monthTimestamp(record.month) }
          : { time: monthTimestamp(record.month), value: record.amount, color: Number(record.month.slice(0, 4)) % 2 === 0 ? '#bc964f' : '#718fab' }))
      } else {
        const options = {
          color: '#76b6e5',
          lineWidth: 2 as const,
          priceLineVisible: false,
          lastValueVisible: false,
          priceFormat: { type: 'custom' as const, formatter: (value: number) => `${growthFormat.format(value)}%`, minMove: 0.1 },
        }
        const calendar = chart.addSeries(LineSeries, options)
        calendar.setData(records.map((record) => ({ time: monthTimestamp(record.month) })))
        calendar.createPriceLine({ price: 0, color: '#526171', lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false })
        let points: Array<{ time: UTCTimestamp; value: number }> = []
        let previousMonth: string | null = null
        const addSegment = () => {
          if (points.length) chart!.addSeries(LineSeries, { ...options, pointMarkersVisible: points.length === 1 }).setData(points)
          points = []
        }
        for (const record of records) {
          const distance = previousMonth ? monthNumber(record.month) - monthNumber(previousMonth) : 1
          const skipsJanuary = distance === 2 && previousMonth?.endsWith('-12') && record.month.endsWith('-02')
          if (record.yoy == null || (distance !== 1 && !skipsJanuary)) addSegment()
          if (record.yoy != null) points.push({ time: monthTimestamp(record.month), value: record.yoy })
          previousMonth = record.month
        }
        addSegment()
      }
      chart.timeScale().fitContent()
      const recordsByTime = new Map(records.map((record) => [monthTimestamp(record.month), record]))
      onMove = (event) => {
        if (!event.point || typeof event.time !== 'number' || event.point.x < 0 || event.point.y < 0 || event.point.x > container.clientWidth || event.point.y > container.clientHeight) {
          setTooltip(null)
          return
        }
        const record = recordsByTime.get(event.time as UTCTimestamp)
        setTooltip(record ? { record, x: event.point.x, y: event.point.y } : null)
      }
      chart.subscribeCrosshairMove(onMove)
      const liveChart = chart
      observer = new ResizeObserver(([entry]) => {
        if (entry.contentRect.width > 0 && entry.contentRect.height > 0) liveChart.applyOptions({ width: entry.contentRect.width, height: entry.contentRect.height })
      })
      observer.observe(container)
    } catch {
      setChartError('图表暂时无法绘制，可切换指标或点击重置缩放重试。')
    }
    return () => {
      observer?.disconnect()
      if (chart && onMove) chart.unsubscribeCrosshairMove(onMove)
      chart?.remove()
    }
  }, [records, metric, hasValues, resetToken])

  return <div className="investment-chart-shell">
    <div ref={containerRef} className="investment-chart" aria-label={`中国固定资产投资${metric === 'yoy' ? '累计同比' : '年初累计金额'}历史趋势图`} />
    {(!hasValues || chartError) && <div className="investment-chart-empty" role="status">{chartError || '当前范围暂无可用数据'}</div>}
    {tooltip && <div className="investment-tooltip" style={{
      left: Math.min(Math.max(tooltip.x + 14, 8), Math.max(8, (containerRef.current?.clientWidth ?? 0) - 235)),
      top: Math.min(Math.max(8, tooltip.y - 115), Math.max(8, (containerRef.current?.clientHeight ?? 0) - 130)),
    }}>
      <p>{cumulativePeriod(tooltip.record.month)} · 全国</p>
      <div><span>年初累计投资</span><strong>{valueText(tooltip.record.amount, 'amount')}</strong></div>
      <div><span>官方累计同比</span><strong>{valueText(tooltip.record.yoy, 'yoy')}</strong></div>
      <small>累计口径 · 不含农户</small>
    </div>}
  </div>
})

const FixedInvestmentPanel = memo(function FixedInvestmentPanel() {
  const [data, setData] = useState<InvestmentResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [metric, setMetric] = useState<InvestmentMetric>('amount')
  const [period, setPeriod] = useState<InvestmentPeriod>('MAX')
  const [resetToken, setResetToken] = useState(0)
  const activeRequest = useRef<AbortController | null>(null)

  const load = useCallback(async (force = false) => {
    if (!force && activeRequest.current) return
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    setLoading(true)
    const timeout = window.setTimeout(() => controller.abort(), 45_000)
    try {
      const response = await fetch(`/api/fixed-investment${force ? '?refresh=1' : ''}`, { signal: controller.signal, cache: 'no-store' })
      const body = await response.json()
      if (!response.ok || !Array.isArray(body.records)) throw new Error(body.error || '固定资产投资数据暂不可用')
      const records = normalizeRecords(body.records)
      if (!records.length) throw new Error('固定资产投资数据暂未发布或加载失败')
      if (activeRequest.current !== controller) return
      const nextData: InvestmentResponse = {
        records,
        annualRecords: normalizeAnnualRecords(Array.isArray(body.annualRecords) ? body.annualRecords : []),
        asOf: typeof body.asOf === 'number' && Number.isFinite(body.asOf) && body.asOf > 0 && body.asOf < 8_640_000_000_000 ? body.asOf : 0,
        latestMonth: typeof body.latestMonth === 'string' && monthPattern.test(body.latestMonth) ? body.latestMonth : records.at(-1)!.month,
        historyStart: typeof body.historyStart === 'string' && monthPattern.test(body.historyStart) ? body.historyStart : records[0].month,
        sourceName: typeof body.sourceName === 'string' ? body.sourceName : '国家统计局',
        sourceUrl: typeof body.sourceUrl === 'string' ? body.sourceUrl : '',
        frequency: typeof body.frequency === 'string' ? body.frequency : '月度发布',
        isStale: body.isStale === true,
        note: typeof body.note === 'string' ? body.note : '',
        releaseDate: typeof body.releaseDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.releaseDate) ? body.releaseDate : undefined,
        releaseSourceUrl: typeof body.releaseSourceUrl === 'string' ? body.releaseSourceUrl : typeof body.officialSourceUrl === 'string' ? body.officialSourceUrl : undefined,
      }
      setData((previous) => ({
        ...nextData,
        records: sameRecords(previous?.records, records) ? previous!.records : records,
        annualRecords: sameAnnualRecords(previous?.annualRecords, nextData.annualRecords) ? previous!.annualRecords : nextData.annualRecords,
      }))
      setError('')
    } catch (reason) {
      if (activeRequest.current !== controller) return
      setError(reason instanceof Error && reason.name !== 'AbortError' ? reason.message : '固定资产投资请求超时，请稍后重试')
    } finally {
      window.clearTimeout(timeout)
      if (activeRequest.current === controller) {
        activeRequest.current = null
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => { void load() }, 5 * 60_000)
    return () => {
      window.clearInterval(timer)
      activeRequest.current?.abort()
      activeRequest.current = null
    }
  }, [load])

  const records = data?.records
  const latest = records?.at(-1)
  const visibleRecords = useMemo(() => {
    if (!records || !latest) return []
    if (period === 'MAX') return records
    const startMonth = monthNumber(latest.month) - (period === '1Y' ? 11 : 59)
    return records.filter((record) => monthNumber(record.month) >= startMonth)
  }, [records, latest, period])
  const fetchedAt = data?.asOf && Number.isFinite(data.asOf) ? fetchTimeFormat.format(new Date(data.asOf * 1000)) : ''
  const sourceUrl = data?.sourceUrl && /^https?:\/\//.test(data.sourceUrl) ? data.sourceUrl : null
  const releaseSourceUrl = data?.releaseSourceUrl && /^https?:\/\//.test(data.releaseSourceUrl) ? data.releaseSourceUrl : null
  const availableGrowth = useMemo(() => visibleRecords.filter((record) => record.yoy != null), [visibleRecords])
  const availableGrowthCount = availableGrowth.length
  const chartRecords = useMemo(() => {
    if (metric === 'amount') return visibleRecords
    if (!availableGrowth.length) return []
    // Trim only unavailable leading/trailing months; keep internal gaps visible.
    const firstMonth = availableGrowth[0].month
    const lastMonth = availableGrowth.at(-1)!.month
    return visibleRecords.filter((record) => record.month >= firstMonth && record.month <= lastMonth)
  }, [metric, visibleRecords, availableGrowth])

  return <section className="investment-panel" aria-labelledby="investment-title" aria-busy={loading}>
    <div className="section-heading investment-heading">
      <div><p className="eyebrow">CHINA MACRO</p><h2 id="investment-title">固定资产投资 <span>/ Fixed Asset Investment</span></h2></div>
      <div className="investment-refresh"><span>{loading ? '正在更新…' : '月度发布 · 每5分钟检查'}</span><button className="icon-button" onClick={() => { void load(true) }} disabled={loading} aria-label="刷新固定资产投资" title="刷新固定资产投资"><RefreshCw size={16} className={loading ? 'spin' : ''} /></button></div>
    </div>
    <p className="investment-intro">中国全国固定资产投资（不含农户） · 国家统计局 · 年初至当前月份的累计统计</p>
    {error && <p className="investment-warning" role="status">{error}{data ? '，保留上次结果。' : '。'}</p>}
    {data?.isStale && <p className="investment-warning" role="status">更新暂不可用，当前显示已保存的数据，以数据所属期为准。</p>}
    <div className="investment-stats">
      <button className={`investment-stat ${metric === 'amount' ? 'selected' : ''}`} aria-pressed={metric === 'amount'} onClick={() => setMetric('amount')}><span>年初累计投资金额</span><strong className="investment-amount">{headlineAmount(latest?.amount)}</strong><small>{latest ? `${cumulativePeriod(latest.month)} · ${valueText(latest.amount, 'amount')} · 现价金额` : loading ? '正在加载…' : '暂无数据'}</small></button>
      <button className={`investment-stat ${metric === 'yoy' ? 'selected' : ''}`} aria-pressed={metric === 'yoy'} onClick={() => setMetric('yoy')}><span>官方累计同比</span><strong className={latest?.yoy == null || latest.yoy === 0 ? '' : latest.yoy > 0 ? 'up' : 'down'}>{valueText(latest?.yoy, 'yoy')}</strong><small>与上年同期比较 · 官方可比口径</small></button>
      <div className="investment-stat investment-period-stat"><span>数据所属期</span><strong>{latest ? cumulativePeriod(latest.month) : '等待发布'}</strong><small>{data?.releaseDate ? `发布日期 ${data.releaseDate} · ` : ''}{fetchedAt ? `检查时间 ${fetchedAt}（北京）` : '月度数据，非实时行情'}</small></div>
    </div>
    <div className="investment-chart-header">
      <div><h3>{metric === 'yoy' ? '固定资产投资 · 累计同比历史' : '固定资产投资 · 年初累计金额'}</h3><p>{chartRecords.length ? `${chartRecords[0].month} — ${chartRecords.at(-1)?.month} · ${metric === 'yoy' ? availableGrowthCount : chartRecords.length}期已取得数据` : metric === 'yoy' ? '当前范围暂无官方累计同比历史' : '等待历史数据'} · {metric === 'yoy' ? '单位：%' : '单位：亿元 · 按年重置，柱色区分年份'} · 悬停看细节，滚轮缩放</p></div>
      <div className="investment-chart-actions">
        <div className="period-control" role="group" aria-label="固定资产投资指标">{([{ value: 'yoy', label: '累计同比' }, { value: 'amount', label: '累计金额' }] as const).map((item) => <button key={item.value} className={metric === item.value ? 'selected' : ''} aria-pressed={metric === item.value} onClick={() => setMetric(item.value)}>{item.label}</button>)}</div>
        <div className="period-control" role="group" aria-label="固定资产投资历史范围">{([{ value: '1Y', label: '1年' }, { value: '5Y', label: '5年' }, { value: 'MAX', label: '全部历史' }] as const).map((item) => <button key={item.value} className={period === item.value ? 'selected' : ''} aria-pressed={period === item.value} onClick={() => { setPeriod(item.value); setResetToken((value) => value + 1) }}>{item.label}</button>)}</div>
        <button className="icon-button" aria-label="重置固定资产投资图表缩放" title="重置缩放，显示所选范围全部数据" onClick={() => setResetToken((value) => value + 1)}><Maximize2 size={15} /></button>
      </div>
    </div>
    {metric === 'yoy' && data && <p className="investment-warning" role="status">{availableGrowthCount ? `当前同比可用起点 ${availableGrowth[0].month}，已取得${availableGrowthCount}期官方值；缺失月份留空，完整投资额历史可切换累计金额查看。` : '历史累计同比尚未取得；切换累计金额可查看全部投资额历史。'}</p>}
    <InvestmentChart records={chartRecords} metric={metric} resetToken={resetToken} />
    <div className="investment-notes">
      <span>金额为年初累计，非单月投资；1月通常不单独公布，2月为1—2月合计。金额每年重新累计，年末与次年年初不能直接计算涨跌。</span>
      <span>累计同比采用国家统计局公布值；历史统计范围及数据可能修订，不用两年累计金额自行反推同比。</span>
      {data?.note && <details><summary>数据口径与历史范围</summary><p>{data.note}</p></details>}
      {sourceUrl && <a href={sourceUrl} target="_blank" rel="noreferrer">{data?.sourceName || '国家统计局'} · 查看数据来源</a>}
      {releaseSourceUrl && releaseSourceUrl !== sourceUrl && <a href={releaseSourceUrl} target="_blank" rel="noreferrer">国家统计局 · 最新官方发布</a>}
    </div>
    <AnnualInvestmentPanel records={data?.annualRecords ?? emptyAnnualRecords} currentPeriod={latest} />
  </section>
})

export default FixedInvestmentPanel

const emptyAnnualRecords: AnnualInvestmentRecord[] = []
