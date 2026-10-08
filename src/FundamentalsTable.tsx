import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { formatChinaTime } from './marketTime'
import type { FundamentalRow, FundamentalsResponse, Market } from './types'

type SortMetric = 'pe' | 'pb' | 'ps' | 'dividendYield'
type FundamentalSort = { metric: SortMetric; direction: 'ascending' | 'descending' }
const SORT_COLUMNS: { metric: SortMetric; name: string; englishName: string }[] = [
  { metric: 'pe', name: '市盈率', englishName: 'P/E' },
  { metric: 'pb', name: '市净率', englishName: 'P/B' },
  { metric: 'ps', name: '市销率', englishName: 'P/S' },
  { metric: 'dividendYield', name: '股息率', englishName: 'Dividend yield' },
]

export function sortFundamentals(rows: readonly FundamentalRow[], sort: FundamentalSort | null) {
  if (!sort) return rows
  return rows.map((row, index) => {
    const raw = row[sort.metric]
    const value = raw == null || !Number.isFinite(raw)
      || ((sort.metric === 'pe' || sort.metric === 'pb') && raw <= 0) ? null : raw
    return { row, index, value }
  }).sort((a, b) => {
    // Unknown values and ratios displayed as N/A stay last in both directions.
    // Preserve watchlist order for ties, including multiple missing values.
    if (a.value === null) return b.value === null ? a.index - b.index : 1
    if (b.value === null) return -1
    return (a.value - b.value) * (sort.direction === 'ascending' ? 1 : -1) || a.index - b.index
  }).map(({ row }) => row)
}

function metric(value: number | null | undefined, unit: string, positiveOnly = false) {
  if (value == null || !Number.isFinite(value)) return '暂无'
  if (positiveOnly && value <= 0) return '不适用'
  return `${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${unit}`
}

function FundamentalsTable({ companies }: { companies: Market[] }) {
  const [data, setData] = useState<FundamentalsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sort, setSort] = useState<FundamentalSort | null>(null)
  const activeRequest = useRef<AbortController | null>(null)

  const load = useCallback(async (force = false) => {
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    setLoading(true)
    const timeout = window.setTimeout(() => controller.abort(), 30_000)
    try {
      const response = await fetch(`/api/fundamentals${force ? '?refresh=1' : ''}`, { signal: controller.signal, cache: 'no-store' })
      const body = await response.json()
      if (!response.ok || !Array.isArray(body.rows)) throw new Error(body.error || '估值数据暂不可用')
      if (controller !== activeRequest.current) return
      setData(body)
      setError('')
    } catch (reason) {
      if (controller !== activeRequest.current) return
      setError(reason instanceof Error && reason.name !== 'AbortError' ? reason.message : '估值数据请求超时，稍后重试')
    } finally {
      window.clearTimeout(timeout)
      if (controller === activeRequest.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const timer = window.setInterval(load, 5 * 60_000)
    return () => {
      window.clearInterval(timer)
      activeRequest.current?.abort()
      activeRequest.current = null
    }
  }, [load])

  const sourceRows = useMemo<FundamentalRow[]>(() => data?.rows ?? companies.map((company) => ({
    key: company.key, symbol: company.symbol, name: company.name, englishName: company.englishName,
    watchStance: company.watchStance,
    pe: null, pb: null, ps: null, dividendYield: null, marketTime: null,
  })), [data, companies])
  const rows = useMemo(() => sortFundamentals(sourceRows, sort), [sourceRows, sort])

  return (
    <section className="fundamentals-panel" aria-labelledby="fundamentals-title" aria-busy={loading}>
      <div className="section-heading">
        <div><p className="eyebrow">COMPANY VALUATION</p><h2 id="fundamentals-title">关注企业估值</h2></div>
        <div className="valuation-refresh">
          <span>{loading ? '正在更新…' : `每5分钟检查${data ? ` · ${formatChinaTime(data.asOf)}` : ''}`}</span>
          <button className="icon-button" onClick={() => load(true)} disabled={loading} aria-label="刷新企业估值" title="刷新企业估值"><RefreshCw size={16} className={loading ? 'spin' : ''} /></button>
        </div>
      </div>
      {error && <p className="valuation-warning" role="status">{error}{data ? '，保留上次结果。' : '。'}</p>}
      <div className="valuation-scroll" role="region" aria-label="企业估值表，可横向滚动" tabIndex={0}>
        <table className="valuation-table">
          <thead><tr>
            <th scope="col">企业 / 股票代码</th>
            {SORT_COLUMNS.map((column) => {
              const direction = sort?.metric === column.metric ? sort.direction : 'none'
              const nextDirection = direction === 'descending' ? 'ascending' : 'descending'
              const label = `${column.name}，点击按${nextDirection === 'ascending' ? '升序' : '降序'}排序`
              return <th key={column.metric} scope="col" aria-sort={direction}>
                <button type="button" className="valuation-sort-button" title={label} aria-label={label}
                  onClick={() => setSort({ metric: column.metric, direction: nextDirection })}>
                  {column.name} <span className="valuation-sort-arrow" aria-hidden="true">{direction === 'ascending' ? '↑' : direction === 'descending' ? '↓' : '↕'}</span>
                  <span>{column.englishName}</span>
                </button>
              </th>
            })}
            <th scope="col">估值日期 / 财报期 / 来源</th>
          </tr></thead>
          <tbody>
            {rows.map((row) => <tr key={row.key}>
              <th scope="row"><div className="watch-stance-cell"><strong>{row.name}</strong>{row.watchStance === 'bearish' && <span className="watch-stance-tag">看空关注</span>}</div><small>{row.englishName} · {row.symbol}</small>{row.note && <details className="valuation-details"><summary>口径说明</summary><span className="valuation-note">{row.note}</span></details>}</th>
              <td><strong>{metric(row.pe, ' 倍', true)}</strong>{row.peBasis && <small>{row.peBasis}</small>}</td>
              <td><strong>{metric(row.pb, ' 倍', true)}</strong>{row.pbBasis && <small>{row.pbBasis}</small>}</td>
              <td><strong>{metric(row.ps, ' 倍')}</strong>{row.psBasis && <small>{row.psBasis}</small>}</td>
              <td><strong>{metric(row.dividendYield, '%')}</strong>{row.dividendBasis && <small>{row.dividendBasis}</small>}</td>
              <td className="valuation-source"><span>{row.valuationDate || (row.marketTime ? formatChinaTime(row.marketTime, true) : '估值日期未披露')}</span>
                {row.reportDate && <small>财报期 {row.reportDate}</small>}
                {row.sourceUrl ? <a href={row.sourceUrl} target="_blank" rel="noreferrer">{row.sourceName || '查看来源'}</a> : <small>{row.sourceName || '等待数据源'}</small>}
                {(row.isStale || error) && <small className="valuation-warning">更新暂不可用 · 上次结果</small>}
              </td>
            </tr>)}
            {!rows.length && <tr><td colSpan={6}>{loading ? '正在加载企业估值…' : '暂无企业估值数据'}</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="valuation-explainer">市盈率 = 股价 / 每股盈利；市净率 = 股价 / 每股净资产；市销率 = 市值 / 营业收入；股息率 = 每股年度股息 / 股价。TTM 表示过去12个月，MRQ 表示最新财报期。市盈率或市净率非正时显示“不适用”；“暂无”表示数据缺失，0.00% 表示来源明确披露为零。</p>
    </section>
  )
}

export default memo(FundamentalsTable)
