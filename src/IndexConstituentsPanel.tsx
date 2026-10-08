import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, Search, X } from 'lucide-react'
import type { FundamentalRow, FundamentalsResponse, IndexConstituent, IndexConstituentsResponse } from './types'
import { sortConstituents, toggleConstituentSort, type ConstituentSort, type ConstituentSortKey } from './constituentSort'

interface ValuationResult {
  row: FundamentalRow | null
  error?: string
}

interface PositionedConstituent { row: IndexConstituent; position: number }
const ROW_HEIGHT = 88
const HEADER_HEIGHT = 60
const EMPTY_CONSTITUENTS: IndexConstituent[] = []
const sortColumns: Array<{ key: ConstituentSortKey; label: string; englishLabel: string }> = [
  { key: 'marketCap', label: '总市值', englishLabel: 'Market cap' },
  { key: 'pe', label: '市盈率', englishLabel: 'P/E' },
  { key: 'pb', label: '市净率', englishLabel: 'P/B' },
  { key: 'ps', label: '市销率', englishLabel: 'P/S' },
  { key: 'dividendYield', label: '股息率', englishLabel: 'Dividend yield' },
]
const quoteTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
})

export function formatConstituentQuoteTime(seconds: number | null | undefined, date?: string | null) {
  if (seconds != null && Number.isFinite(seconds) && seconds > 0 && Number.isFinite(new Date(seconds * 1000).getTime())) {
    return quoteTimeFormatter.format(seconds * 1000)
  }
  return date ? `${date}（时刻未披露）` : '行情时间未披露'
}

export function getConstituentWindow(total: number, scrollTop: number, viewportHeight: number, rowHeight = ROW_HEIGHT, overscan = 20) {
  const first = Math.max(0, Math.min(total, Math.floor(Math.max(0, scrollTop) / rowHeight)))
  const start = Math.max(0, first - overscan)
  const end = Math.min(total, first + Math.ceil(Math.max(0, viewportHeight - HEADER_HEIGHT) / rowHeight) + overscan + 1)
  return { start, end, top: start * rowHeight, bottom: (total - end) * rowHeight }
}

export function getConstituentAnchorOffset(before: readonly string[], after: readonly string[], scrollTop: number, rowHeight = ROW_HEIGHT) {
  if (scrollTop < rowHeight / 2) return 0
  const position = Math.min(before.length - 1, Math.floor(scrollTop / rowHeight))
  const key = before[position]
  const nextPosition = key ? after.indexOf(key) : -1
  return nextPosition < 0 ? 0 : nextPosition * rowHeight + scrollTop % rowHeight
}

export function mergeConstituentValuations(previous: ReadonlyMap<string, ValuationResult>, incoming: ReadonlyMap<string, ValuationResult>) {
  const next = new Map(previous)
  for (const [key, result] of incoming) {
    const prior = previous.get(key)?.row
    next.set(key, !result.row && result.error && prior ? { ...result, row: { ...prior, isStale: true } } : result)
  }
  return next
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
  return sortConstituents(rows, valuations, { key: 'marketCap', direction: 'descending' })
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

const ConstituentRow = memo(function ConstituentRow({ company, result, position, rowIndex, selected, onSelect }: {
  company: IndexConstituent
  result: ValuationResult | undefined
  position: number
  rowIndex: number
  selected: boolean
  onSelect: (key: string) => void
}) {
  const row = result?.row
  const pending = !result
  const displayName = row?.name || company.name || company.englishName || company.symbol
  return <tr className="constituent-virtual-row" aria-rowindex={rowIndex}>
    <th scope="row"><div className="constituent-cell"><div className="constituent-name"><span className="constituent-position">{position}</span><strong title={displayName}>{displayName}</strong></div><small title={`${company.englishName || ''} · ${company.symbol} · ${company.exchange || company.market}`}>{company.englishName && company.englishName !== displayName ? `${company.englishName} · ` : ''}{company.symbol} · {company.exchange || company.market}</small></div></th>
    <td className="constituent-market-cap"><div className="constituent-cell"><strong>{pending ? '等待加载' : formatConstituentMarketCap(row?.marketCap)}</strong>{row?.marketCapCurrency && <small>{currencyLabels[row.marketCapCurrency] || row.marketCapCurrency}</small>}</div></td>
    <td><div className="constituent-cell"><strong>{pending ? '等待加载' : metric(row?.pe, ' 倍', true)}</strong>{row?.peBasis && <small title={row.peBasis}>{row.peBasis}</small>}</div></td>
    <td><div className="constituent-cell"><strong>{pending ? '等待加载' : metric(row?.pb, ' 倍', true)}</strong>{row?.pbBasis && <small title={row.pbBasis}>{row.pbBasis}</small>}</div></td>
    <td><div className="constituent-cell"><strong>{pending ? '等待加载' : metric(row?.ps, ' 倍')}</strong>{row?.psBasis && <small title={row.psBasis}>{row.psBasis}</small>}</div></td>
    <td><div className="constituent-cell"><strong>{pending ? '等待加载' : metric(row?.dividendYield, '%')}</strong>{row?.dividendBasis && <small title={row.dividendBasis}>{row.dividendBasis}</small>}</div></td>
    <td className="valuation-source"><div className="constituent-cell">
      <span className="constituent-quote-time">{pending ? '估值正在依次加载' : formatConstituentQuoteTime(row?.marketTime, row?.valuationDate)}</span>
      {!pending && <button className="constituent-details-button" onClick={() => onSelect(company.key)} aria-expanded={selected} aria-controls="constituent-source-details" aria-label={`${displayName}口径与来源`}>口径与来源</button>}
      {(row?.isStale || result?.error) && <small className="valuation-warning">{row?.isStale ? '保留上次估值' : '暂不可用 · 可刷新重试'}</small>}
    </div></td>
  </tr>
})

function IndexConstituentsPanel({ indexKey, indexName }: { indexKey: string; indexName: string }) {
  const [data, setData] = useState<IndexConstituentsResponse | null>(null)
  const [valuations, setValuations] = useState<Map<string, ValuationResult>>(() => new Map())
  const [loadingList, setLoadingList] = useState(true)
  const [loadingValuations, setLoadingValuations] = useState(false)
  const [listError, setListError] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<ConstituentSort>({ key: 'marketCap', direction: 'descending' })
  const [queriedCount, setQueriedCount] = useState(0)
  const [displayRows, setDisplayRows] = useState<PositionedConstituent[]>([])
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(590)
  const [scrolling, setScrolling] = useState(false)
  const [selectedSourceKey, setSelectedSourceKey] = useState<string | null>(null)
  const requestRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const displayRowsRef = useRef<PositionedConstituent[]>([])
  const scrollTopRef = useRef(0)
  const ignoreScrollRef = useRef<number | null>(null)
  const scrollFrameRef = useRef<number | null>(null)
  const scrollIdleRef = useRef<number | null>(null)
  const appliedQueryRef = useRef('')
  const appliedSortRef = useRef(sort)

  const load = useCallback(async (force = false) => {
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setLoadingList(true)
    setLoadingValuations(false)
    setListError('')
    setQueriedCount(0)
    let completedCount = 0
    let flushTimer: number | null = null
    const buffered = new Map<string, ValuationResult>()
    const flush = () => {
      if (flushTimer != null) window.clearTimeout(flushTimer)
      flushTimer = null
      if (controller.signal.aborted || requestRef.current !== controller || !buffered.size) return
      const incoming = new Map(buffered)
      buffered.clear()
      setValuations((previous) => mergeConstituentValuations(previous, incoming))
      setQueriedCount(completedCount)
    }
    const cancelFlush = () => {
      if (flushTimer != null) window.clearTimeout(flushTimer)
      flushTimer = null
      buffered.clear()
    }
    controller.signal.addEventListener('abort', cancelFlush, { once: true })
    try {
      const body = await getJson<IndexConstituentsResponse>(`/api/index-constituents?key=${encodeURIComponent(indexKey)}${force ? '&refresh=1' : ''}`, controller.signal, 90_000)
      if (requestRef.current !== controller || controller.signal.aborted) return
      if (!Array.isArray(body.rows)) throw new Error('成分股名单格式异常')
      const seen = new Set<string>()
      const rows = body.rows.filter((row) => {
        if (!row || typeof row.key !== 'string' || !row.key || typeof row.symbol !== 'string' || seen.has(row.key)) return false
        seen.add(row.key)
        return true
      })
      setData({ ...body, rows })
      setValuations((previous) => new Map([...previous].filter(([key]) => seen.has(key))))
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
            const response = await getJson<FundamentalsResponse>(`/api/constituent-valuations?symbols=${encodeURIComponent(symbols)}${force ? '&refresh=1' : ''}`, controller.signal)
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
          for (const [key, result] of results) buffered.set(key, result)
          completedCount += batch.length
          if (flushTimer == null) flushTimer = window.setTimeout(flush, 350)
        }
      }
      await Promise.all([worker(), worker()])
    } catch (reason) {
      if (controller.signal.aborted || requestRef.current !== controller) return
      setListError(reason instanceof Error ? reason.message : '成分股名单暂不可用')
    } finally {
      flush()
      cancelFlush()
      controller.signal.removeEventListener('abort', cancelFlush)
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
      if (scrollFrameRef.current != null) window.cancelAnimationFrame(scrollFrameRef.current)
      if (scrollIdleRef.current != null) window.clearTimeout(scrollIdleRef.current)
    }
  }, [load])

  const rows = data?.rows ?? EMPTY_CONSTITUENTS
  const sortedRows = useMemo(() => sortConstituents(rows, valuations, sort).map((row, index) => ({ row, position: index + 1 })), [rows, valuations, sort])
  const filtered = useMemo(() => {
    const search = query.trim().toLocaleLowerCase()
    return sortedRows.filter(({ row }) => !search || [row.name, row.englishName, row.symbol, row.key, valuations.get(row.key)?.row?.name, valuations.get(row.key)?.row?.englishName].some((value) => value?.toLocaleLowerCase().includes(search)))
  }, [sortedRows, query, valuations])

  useLayoutEffect(() => {
    if (scrolling) return
    const changedControls = appliedQueryRef.current !== query || appliedSortRef.current !== sort
    const nextOffset = changedControls ? 0 : getConstituentAnchorOffset(
      displayRowsRef.current.map(({ row }) => row.key), filtered.map(({ row }) => row.key), scrollTopRef.current,
    )
    appliedQueryRef.current = query
    appliedSortRef.current = sort
    displayRowsRef.current = filtered
    setDisplayRows(filtered)
    if (scrollRef.current) {
      const limit = Math.max(0, HEADER_HEIGHT + filtered.length * ROW_HEIGHT - scrollRef.current.clientHeight)
      const target = Math.min(limit, nextOffset)
      ignoreScrollRef.current = target
      scrollTopRef.current = target
      scrollRef.current.scrollTop = target
      setScrollTop(target)
    }
  }, [filtered, query, sort, scrolling])

  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    const observer = new ResizeObserver(() => setViewportHeight(container.clientHeight))
    observer.observe(container)
    setViewportHeight(container.clientHeight)
    return () => observer.disconnect()
  }, [data?.status])

  const handleScroll = useCallback(() => {
    const container = scrollRef.current
    if (!container) return
    const offset = container.scrollTop
    scrollTopRef.current = offset
    if (scrollFrameRef.current == null) scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null
      setScrollTop(scrollTopRef.current)
    })
    if (ignoreScrollRef.current != null && Math.abs(offset - ignoreScrollRef.current) < 1) {
      ignoreScrollRef.current = null
      return
    }
    ignoreScrollRef.current = null
    setScrolling(true)
    if (scrollIdleRef.current != null) window.clearTimeout(scrollIdleRef.current)
    scrollIdleRef.current = window.setTimeout(() => {
      scrollIdleRef.current = null
      setScrolling(false)
    }, 220)
  }, [])

  const selectSource = useCallback((key: string) => setSelectedSourceKey((previous) => previous === key ? null : key), [])
  const changeSort = useCallback((key: ConstituentSortKey) => {
    if (scrollIdleRef.current != null) window.clearTimeout(scrollIdleRef.current)
    scrollIdleRef.current = null
    setScrolling(false)
    setSort((previous) => toggleConstituentSort(previous, key))
  }, [])
  const sortLabel = `${sortColumns.find((column) => column.key === sort.key)?.label} ${sort.direction === 'ascending' ? '升序（从低到高）' : '降序（从高到低）'}`
  const visibleWindow = getConstituentWindow(displayRows.length, scrollTop, viewportHeight)
  const mountedRows = displayRows.slice(visibleWindow.start, visibleWindow.end)
  const sourceCompany = selectedSourceKey ? rows.find((row) => row.key === selectedSourceKey) : undefined
  const sourceResult = selectedSourceKey ? valuations.get(selectedSourceKey) : undefined
  const sourceRow = sourceResult?.row
  const availableCount = useMemo(() => [...valuations.values()].filter(({ row }) => row && [row.pe, row.pb, row.ps, row.dividendYield].some((value) => value != null && Number.isFinite(value))).length, [valuations])
  const marketCapCount = useMemo(() => [...valuations.values()].filter(({ row }) => row?.marketCap != null && Number.isFinite(row.marketCap) && row.marketCap > 0).length, [valuations])
  const failedCount = useMemo(() => [...valuations.values()].filter((result) => result.error).length, [valuations])
  const loading = loadingList || loadingValuations
  const incomplete = data?.total != null && rows.length < data.total

  return <section className="constituents-panel" aria-labelledby="constituents-title">
    <div className="section-heading constituents-heading">
      <div><p className="eyebrow">INDEX CONSTITUENTS</p><h2 id="constituents-title">{data?.indexName || indexName} · 成分股估值</h2></div>
      <button className="constituents-refresh" onClick={() => load(true)} disabled={loadingList} aria-label="刷新成分股及估值"><RefreshCw size={14} className={loading ? 'spin' : ''} />{loadingList ? '正在获取名单' : loadingValuations ? '重新刷新' : '刷新名单与估值'}</button>
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
        <label className="constituents-search"><Search size={15} /><input type="search" value={query} onChange={(event) => { setScrolling(false); setQuery(event.target.value) }} placeholder="搜索名称或股票代码" aria-label="搜索指数成分股" /></label>
        <div className="constituents-progress" role="status"><span>{query.trim() ? `搜索结果 ${filtered.length} / ${rows.length} 项` : `显示全部 ${rows.length.toLocaleString()} 项 · 表内滚动查看`} · {sortLabel}</span><small>本次已查询 {queriedCount.toLocaleString()} / {rows.length.toLocaleString()} · 市值 {marketCapCount.toLocaleString()} · 估值 {availableCount.toLocaleString()}{loadingValuations ? ' · 加载中，排序持续更新' : ''}</small></div>
      </div>
      {failedCount > 0 && <p className="valuation-warning" role="status">{failedCount} 项估值请求暂未成功，已标为“暂无”；点击刷新可重新获取。</p>}
      <div className="valuation-scroll constituents-scroll" ref={scrollRef} onScroll={handleScroll} role="region" aria-label="全部指数成分股估值表，可上下及横向滚动" tabIndex={0}>
        <table className="valuation-table constituents-table" aria-rowcount={displayRows.length + 1}>
          <colgroup><col className="constituent-company-column" /><col /><col /><col /><col /><col /><col className="constituent-source-column" /></colgroup>
          <thead><tr aria-rowindex={1}><th scope="col">成分股 / 股票代码</th>{sortColumns.map((column) => {
            const active = sort.key === column.key
            const nextDirection = toggleConstituentSort(sort, column.key).direction === 'ascending' ? '升序' : '降序'
            return <th key={column.key} scope="col" aria-sort={active ? sort.direction : 'none'}><button type="button" className="valuation-sort-button" onClick={() => changeSort(column.key)} aria-label={`${column.label}，点击按${nextDirection}排列`} title={`按${column.label}${nextDirection}排列`}>{column.label} <span className="valuation-sort-arrow" aria-hidden="true">{active ? sort.direction === 'ascending' ? '↑' : '↓' : '↕'}</span><span>{column.englishLabel}</span></button></th>
          })}<th scope="col">市值 / 估值行情时间<span>北京时间 · 原始行情时间</span></th></tr></thead>
          <tbody>
            {visibleWindow.top > 0 && <tr className="constituent-spacer" aria-hidden="true"><td colSpan={7} style={{ height: visibleWindow.top }} /></tr>}
            {mountedRows.map(({ row, position }, offset) => <ConstituentRow key={row.key} company={row} position={position} rowIndex={visibleWindow.start + offset + 2} result={valuations.get(row.key)} selected={selectedSourceKey === row.key} onSelect={selectSource} />)}
            {visibleWindow.bottom > 0 && <tr className="constituent-spacer" aria-hidden="true"><td colSpan={7} style={{ height: visibleWindow.bottom }} /></tr>}
            {!displayRows.length && <tr><td colSpan={7} className="constituents-empty">{loadingList ? '正在加载全部成分股名单…' : query.trim() ? '没有匹配的成分股，请修改或清空搜索。' : '当前暂无可用成分股名单。'}</td></tr>}
          </tbody>
        </table>
      </div>
      {sourceCompany && sourceResult && <div className="constituent-source-panel" id="constituent-source-details" role="region" aria-labelledby="constituent-source-title">
        <div className="constituent-source-heading"><strong id="constituent-source-title">{sourceRow?.name || sourceCompany.name || sourceCompany.symbol} · {sourceCompany.symbol} · 口径与来源</strong><button className="icon-button" onClick={() => setSelectedSourceKey(null)} aria-label="关闭成分股来源详情"><X size={15} /></button></div>
        <p>原始行情时间（北京时间）：{formatConstituentQuoteTime(sourceRow?.marketTime, sourceRow?.valuationDate)}{sourceRow?.isStale ? ' · 保留上次结果' : ''}</p>
        {sourceRow?.reportDate && <p>财报期：{sourceRow.reportDate}</p>}
        <p>市值：{formatConstituentMarketCap(sourceRow?.marketCap)} {sourceRow?.marketCapCurrency ? currencyLabels[sourceRow.marketCapCurrency] || sourceRow.marketCapCurrency : ''}{sourceRow?.marketCapNote ? ` · ${sourceRow.marketCapNote}` : ''}</p>
        <p>{[['市盈率', sourceRow?.peBasis], ['市净率', sourceRow?.pbBasis], ['市销率', sourceRow?.psBasis], ['股息率', sourceRow?.dividendBasis]].filter(([, basis]) => basis).map(([label, basis]) => `${label}：${basis}`).join('；')}</p>
        <p>{sourceResult.error || sourceRow?.note || '数据源暂未提供可核实的估值指标。'}</p>
        {sourceRow?.sourceUrl ? <a href={sourceRow.sourceUrl} target="_blank" rel="noreferrer">{sourceRow.sourceName || '查看估值数据源'}</a> : <span>{sourceRow?.sourceName || '估值数据暂不可用'}</span>}
      </div>}
    </>}
    <p className="valuation-explainer">{data?.note && `${data.note} `}成分股按最新可用名单展示，不随走势图历史日期变化。点击市值或估值列头可切换升降序，缺失、不可比或不适用的指标始终置于末尾；金额按所标币种显示，涉及币种换算的排序口径见来源详情。表内可滚动查看全部名单，市值与估值依次补全；刷新会重新请求数据源，显示的时间始终来自原始行情。“暂无”代表缺失，“不适用”代表市盈率或市净率非正，股息率缺失不填0。</p>
  </section>
}

export default memo(IndexConstituentsPanel)
