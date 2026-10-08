import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, Search } from 'lucide-react'
import type { FundamentalRow, FundamentalsResponse, IndexConstituent, IndexConstituentsResponse } from './types'

interface ValuationResult {
  row: FundamentalRow | null
  error?: string
}

const currencyLabels: Record<string, string> = {
  USD: '美元 USD', HKD: '港币 HKD', CNY: '人民币 CNY', GBP: '英镑 GBP',
  EUR: '欧元 EUR', JPY: '日元 JPY', KRW: '韩元 KRW',
}

export function formatConstituentMarketCap(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value <= 0) return '暂无'
  const divisor = value >= 1e12 ? 1e12 : value >= 1e8 ? 1e8 : value >= 1e4 ? 1e4 : 1
  const unit = divisor === 1e12 ? '万亿' : divisor === 1e8 ? '亿' : divisor === 1e4 ? '万' : ''
  return `${(value / divisor).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${unit}`
}

export function sortConstituentsByMarketCap(rows: readonly IndexConstituent[], valuations: ReadonlyMap<string, ValuationResult>) {
  return rows.map((company, originalPosition) => {
    const row = valuations.get(company.key)?.row
    // Explicit null means no comparable currency value is available.
    const value = row?.marketCapSortValue !== undefined ? row.marketCapSortValue : row?.marketCap
    const marketCap = value != null && Number.isFinite(value) && value > 0 ? value : null
    return { company, originalPosition, marketCap }
  }).sort((a, b) => {
    if (a.marketCap == null && b.marketCap != null) return 1
    if (a.marketCap != null && b.marketCap == null) return -1
    return (a.marketCap != null && b.marketCap != null ? b.marketCap - a.marketCap : 0) || a.originalPosition - b.originalPosition
  }).map(({ company }) => company)
}

function metric(value: number | null | undefined, unit: string, positiveOnly = false) {
  if (value == null || !Number.isFinite(value)) return '暂无'
  if (positiveOnly && value <= 0) return '不适用'
  return `${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${unit}`
}

async function getJson<T>(url: string, signal: AbortSignal, timeoutMs = 45_000): Promise<T> {
  const deadline = new AbortController()
  const timeout = window.setTimeout(() => deadline.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: AbortSignal.any([signal, deadline.signal]), cache: 'no-store' })
    const body = await response.json()
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : '数据请求失败')
    return body as T
  } catch (reason) {
    if (deadline.signal.aborted && !signal.aborted) throw new Error('数据请求超时，可点击刷新重试')
    throw reason
  } finally {
    window.clearTimeout(timeout)
  }
}

const ConstituentRow = memo(function ConstituentRow({ company, result, position }: {
  company: IndexConstituent
  result: ValuationResult | undefined
  position: number
}) {
  const row = result?.row
  const pending = !result
  const fields = row ? [row.marketCap, row.pe, row.pb, row.ps, row.dividendYield] : []
  const available = fields.some((value) => value != null && Number.isFinite(value))
  const displayName = row?.name || company.name || company.englishName || company.symbol
  return <tr>
    <th scope="row"><div className="constituent-name"><span className="constituent-position">{position}</span><strong>{displayName}</strong></div><small>{company.englishName && company.englishName !== displayName ? `${company.englishName} · ` : ''}{company.symbol} · {company.exchange || company.market}</small></th>
    <td className="constituent-market-cap"><strong>{pending ? '等待加载' : formatConstituentMarketCap(row?.marketCap)}</strong>{row?.marketCapCurrency && <small>{currencyLabels[row.marketCapCurrency] || row.marketCapCurrency}</small>}{row?.marketCapNote && <small>口径见来源详情</small>}</td>
    <td><strong>{pending ? '等待加载' : metric(row?.pe, ' 倍', true)}</strong>{row?.peBasis && <small>{row.peBasis}</small>}</td>
    <td><strong>{pending ? '等待加载' : metric(row?.pb, ' 倍', true)}</strong>{row?.pbBasis && <small>{row.pbBasis}</small>}</td>
    <td><strong>{pending ? '等待加载' : metric(row?.ps, ' 倍')}</strong>{row?.psBasis && <small>{row.psBasis}</small>}</td>
    <td><strong>{pending ? '等待加载' : metric(row?.dividendYield, '%')}</strong>{row?.dividendBasis && <small>{row.dividendBasis}</small>}</td>
    <td className="valuation-source">
      <span>{pending ? '估值正在依次加载' : row?.valuationDate || '估值日期未披露'}</span>
      {!pending && <details className="valuation-details constituent-details"><summary>口径与来源</summary>
        {row?.sourceUrl ? <a href={row.sourceUrl} target="_blank" rel="noreferrer">{row.sourceName || '估值数据源'}</a> : <span>{row?.sourceName || '估值数据暂不可用'}</span>}
        {row?.reportDate && <small>财报期 {row.reportDate}</small>}
        {row?.marketCapNote && <span className="valuation-note">市值：{row.marketCapNote}</span>}
        <span className="valuation-note">{result.error || row?.note || (available ? '各指标以数据源披露口径为准。' : '数据源未提供可核实的估值指标。')}</span>
      </details>}
      {row?.isStale && <small className="valuation-warning">保留上次估值</small>}
      {result?.error && <small className="valuation-warning">暂不可用 · 可刷新重试</small>}
    </td>
  </tr>
})

function IndexConstituentsPanel({ indexKey, indexName }: { indexKey: string; indexName: string }) {
  const [data, setData] = useState<IndexConstituentsResponse | null>(null)
  const [valuations, setValuations] = useState<Map<string, ValuationResult>>(() => new Map())
  const [loadingList, setLoadingList] = useState(true)
  const [loadingValuations, setLoadingValuations] = useState(false)
  const [listError, setListError] = useState('')
  const [query, setQuery] = useState('')
  const requestRef = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setLoadingList(true)
    setLoadingValuations(false)
    setListError('')
    try {
      const body = await getJson<IndexConstituentsResponse>(`/api/index-constituents?key=${encodeURIComponent(indexKey)}`, controller.signal, 90_000)
      if (requestRef.current !== controller || controller.signal.aborted) return
      if (!Array.isArray(body.rows)) throw new Error('成分股名单格式异常')
      const seen = new Set<string>()
      const rows = body.rows.filter((row) => {
        if (!row || typeof row.key !== 'string' || !row.key || typeof row.symbol !== 'string' || seen.has(row.key)) return false
        seen.add(row.key)
        return true
      })
      setData({ ...body, rows })
      setValuations(new Map())
      setLoadingList(false)
      if (body.status === 'unavailable' || !rows.length) return

      setLoadingValuations(true)
      let nextBatch = 0
      const batches = Array.from({ length: Math.ceil(rows.length / 20) }, (_, position) => rows.slice(position * 20, position * 20 + 20))
      const worker = async () => {
        while (!controller.signal.aborted && requestRef.current === controller && nextBatch < batches.length) {
          const batch = batches[nextBatch++]
          const results = new Map<string, ValuationResult>()
          try {
            const symbols = batch.map((row) => row.key).join(',')
            const response = await getJson<FundamentalsResponse>(`/api/constituent-valuations?symbols=${encodeURIComponent(symbols)}`, controller.signal)
            if (!Array.isArray(response.rows)) throw new Error('估值数据格式异常')
            const requested = new Set(batch.map((row) => row.key))
            for (const row of response.rows) {
              if (row && requested.has(row.key)) results.set(row.key, { row })
            }
            for (const row of batch) {
              if (!results.has(row.key)) results.set(row.key, { row: null, error: '数据源未返回该成分股的估值，稍后可刷新重试。' })
            }
          } catch (reason) {
            if (controller.signal.aborted || requestRef.current !== controller) return
            const message = reason instanceof Error ? reason.message : '估值暂不可用，可刷新重试'
            for (const row of batch) results.set(row.key, { row: null, error: message })
          }
          if (controller.signal.aborted || requestRef.current !== controller) return
          setValuations((previous) => new Map([...previous, ...results]))
        }
      }
      await Promise.all([worker(), worker()])
    } catch (reason) {
      if (controller.signal.aborted || requestRef.current !== controller) return
      setListError(reason instanceof Error ? reason.message : '成分股名单暂不可用')
    } finally {
      if (requestRef.current === controller && !controller.signal.aborted) {
        setLoadingList(false)
        setLoadingValuations(false)
      }
    }
  }, [indexKey])

  useEffect(() => {
    load()
    return () => {
      requestRef.current?.abort()
      requestRef.current = null
    }
  }, [load])

  const rows = data?.rows ?? []
  const filtered = useMemo(() => {
    const search = query.trim().toLocaleLowerCase()
    return sortConstituentsByMarketCap(rows, valuations).map((row, index) => ({ row, position: index + 1 })).filter(({ row }) => !search || [row.name, row.englishName, row.symbol, row.key, valuations.get(row.key)?.row?.name, valuations.get(row.key)?.row?.englishName].some((value) => value?.toLocaleLowerCase().includes(search)))
  }, [rows, query, valuations])
  const availableCount = useMemo(() => [...valuations.values()].filter(({ row }) => row && [row.pe, row.pb, row.ps, row.dividendYield].some((value) => value != null && Number.isFinite(value))).length, [valuations])
  const marketCapCount = useMemo(() => [...valuations.values()].filter(({ row }) => row?.marketCap != null && Number.isFinite(row.marketCap) && row.marketCap > 0).length, [valuations])
  const failedCount = useMemo(() => [...valuations.values()].filter((result) => result.error).length, [valuations])
  const loading = loadingList || loadingValuations
  const incomplete = data?.total != null && rows.length < data.total

  return <section className="constituents-panel" aria-labelledby="constituents-title">
    <div className="section-heading constituents-heading">
      <div><p className="eyebrow">INDEX CONSTITUENTS</p><h2 id="constituents-title">{data?.indexName || indexName} · 成分股估值</h2></div>
      <button className="constituents-refresh" onClick={load} disabled={loadingList} aria-label="刷新成分股及估值"><RefreshCw size={14} className={loading ? 'spin' : ''} />{loadingList ? '正在获取名单' : loadingValuations ? '重新刷新' : '刷新名单与估值'}</button>
    </div>
    <div className="constituents-meta">
      <span>{data ? `已获取 ${rows.length.toLocaleString()} 项${data.total != null ? ` / 来源总数 ${data.total.toLocaleString()}` : ''}` : '正在获取全部成分股名单…'}</span>
      {data?.holdingsDate && <span>成分日期 {data.holdingsDate}</span>}
      {data?.sourceUrl && <a href={data.sourceUrl} target="_blank" rel="noreferrer">名单来源：{data.sourceName || '查看数据源'}</a>}
    </div>
    {listError && <p className="valuation-warning" role="status">{listError}{data ? '，保留上次获取的名单与估值。' : '，可点击刷新重试。'}</p>}
    {data?.isStale && <p className="valuation-warning">名单更新暂不可用，显示已保存的成分股。</p>}
    {incomplete && <p className="valuation-warning" role="status">当前来源仅返回 {rows.length} / {data?.total} 项，尚未取得完整名单；下方展示所有已获取记录。</p>}
    {data?.status === 'unavailable' ? <div className="constituents-empty" role="status">{data.reason || '当前数据源暂不提供这个指数的完整成分股名单。'}</div> : <>
      <div className="constituents-toolbar">
        <label className="constituents-search"><Search size={15} /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称或股票代码" aria-label="搜索指数成分股" /></label>
        <div className="constituents-progress" role="status"><span>{query.trim() ? `搜索结果 ${filtered.length} / ${rows.length} 项` : `显示全部 ${rows.length.toLocaleString()} 项 · 表内滚动查看`} · 市值从高到低</span><small>已查询 {valuations.size.toLocaleString()} / {rows.length.toLocaleString()} · 市值 {marketCapCount.toLocaleString()} · 估值 {availableCount.toLocaleString()}{loadingValuations ? ' · 加载中，排序持续更新' : ''}</small></div>
      </div>
      {failedCount > 0 && <p className="valuation-warning" role="status">{failedCount} 项估值请求暂未成功，已标为“暂无”；点击刷新可重新获取。</p>}
      <div className="valuation-scroll constituents-scroll" role="region" aria-label="全部指数成分股估值表，可上下及横向滚动" tabIndex={0}>
        <table className="valuation-table constituents-table">
          <thead><tr><th scope="col">成分股 / 股票代码</th><th scope="col" aria-sort="descending">总市值 ↓ <span>Market cap</span></th><th scope="col">市盈率 <span>P/E</span></th><th scope="col">市净率 <span>P/B</span></th><th scope="col">市销率 <span>P/S</span></th><th scope="col">股息率 <span>Dividend yield</span></th><th scope="col">市值 / 估值日期与来源</th></tr></thead>
          <tbody>
            {filtered.map(({ row, position }) => <ConstituentRow key={row.key} company={row} position={position} result={valuations.get(row.key)} />)}
            {!filtered.length && <tr><td colSpan={7} className="constituents-empty">{loadingList ? '正在加载全部成分股名单…' : query.trim() ? '没有匹配的成分股，请修改或清空搜索。' : '当前暂无可用成分股名单。'}</td></tr>}
          </tbody>
        </table>
      </div>
    </>}
    <p className="valuation-explainer">{data?.note && `${data.note} `}成分股按最新可用名单展示，不随走势图历史日期变化。总市值从高到低排列，缺失项置于末尾；金额按所标币种显示，涉及币种换算的排序口径见来源详情。全部名单先显示，市值与估值依次补全；“暂无”代表缺失，“不适用”代表市盈率或市净率非正，股息率缺失不填0。</p>
  </section>
}

export default memo(IndexConstituentsPanel)
