import { memo, useEffect, useMemo, useState } from 'react'
import { Activity, AlertCircle, BarChart3, Clock3, RefreshCw, Wifi, WifiOff } from 'lucide-react'
import TrendChart from './TrendChart'
import FundamentalsTable from './FundamentalsTable'
import IndexConstituentsPanel from './IndexConstituentsPanel'
import HousingPanel from './HousingPanel'
import FixedInvestmentPanel from './FixedInvestmentPanel'
import EtfTotalReturnPanel from './EtfTotalReturnPanel'
import { formatChinaTime, formatNewYorkTime, getCashSessionState, getSessionState } from './marketTime'
import type { Market, Period } from './types'
import { convertCurrencyMarket, formatMarketNumber, type CurrencyDirection } from './currency'
import { mergeQuoteAndHistory } from './marketData'
import { useMarketHistory, useMarketQuotes } from './useMarketData'

const periods: Array<{ value: Period; label: string }> = [
  { value: '1D', label: '日内' },
  { value: '5D', label: '5日' },
  { value: '1M', label: '1月' },
  { value: '3M', label: '3月' },
  { value: '1Y', label: '1年' },
  { value: '5Y', label: '5年' },
  { value: 'MAX', label: '历史' },
]

const marketGroups = [
  { key: 'indices', title: '指数', caption: '全球股市指数与股指期货', includes: (market: Market) => (market.kind === 'index' || market.kind === 'futures') && market.key !== 'CFETS' },
  { key: 'etfs', title: '基金 / ETF', caption: '场内ETF与场外联接基金', includes: (market: Market) => market.kind === 'etf' || market.kind === 'fund' },
  { key: 'stocks', title: '个股', caption: '关注的上市企业', includes: (market: Market) => market.kind === 'stock' },
  { key: 'currencies', title: '货币', caption: '人民币汇率、汇率指数与黄金', includes: (market: Market) => market.kind === 'forex' || market.kind === 'metal' || market.key === 'CFETS' },
]

const signed = new Intl.NumberFormat('en-US', { signDisplay: 'always', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const TROY_OUNCE_GRAMS = 31.1034768
type GoldUnit = 'USD' | 'CNY'

const rmbCurrencyPairs = {
  USDCNY: { foreign: '美元', forward: 'USDCNY', inverse: 'CNYUSD', groupLabel: '人民币美元报价方向' },
  EURCNY: { foreign: '欧元', forward: 'EURCNY', inverse: 'CNYEUR', groupLabel: '人民币欧元报价方向' },
} as const

function isRmbCurrencyMarket(market: Market): market is Market & { key: keyof typeof rmbCurrencyPairs } {
  return market.key === 'USDCNY' || market.key === 'EURCNY'
}

function currencyExchangeNote(market: Market, includeDirection = false) {
  if (!isRmbCurrencyMarket(market)) return ''
  const { foreign } = rmbCurrencyPairs[market.key]
  const isInverse = market.symbol.startsWith('CNY/')
  if (!includeDirection) return isInverse ? `1 人民币可兑换的${foreign}` : `1 ${foreign}可兑换的人民币`
  return isInverse
    ? `1 人民币 = ${formatMarketNumber(market.price, market)} ${foreign}；数值上升表示人民币升值。`
    : `1 ${foreign} = ${formatMarketNumber(market.price, market)} 人民币；数值上升表示人民币贬值。`
}

function formatHistoryDate(timestamp: number | null | undefined, timeZone = 'Asia/Shanghai') {
  return timestamp ? new Intl.DateTimeFormat('zh-CN', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestamp * 1000)) : '--'
}

function convertGoldMarket(market: Market, unit: GoldUnit, fxRate: number | null | undefined): Market {
  if (market.key !== 'XAU' || unit === 'USD' || !fxRate) return market
  const factor = fxRate / TROY_OUNCE_GRAMS
  const convert = (value: number | null) => value === null ? null : value * factor
  return {
    ...market,
    currency: 'CNY',
    unit: 'CNY/g',
    price: convert(market.price),
    previousClose: convert(market.previousClose),
    change: convert(market.change),
    dayHigh: convert(market.dayHigh),
    dayLow: convert(market.dayLow),
    points: market.points.map((point) => ({
      ...point,
      open: convert(point.open),
      high: convert(point.high),
      low: convert(point.low),
      close: point.close * factor,
    })),
  }
}

const MarketCard = memo(function MarketCard({ market, active, onClick }: { market: Market; active: boolean; onClick: () => void }) {
  const positive = (market.change ?? 0) >= 0
  const cardLabel = market.kind === 'forex' ? market.englishName
    : market.kind === 'etf' || market.kind === 'fund' ? `${market.symbol} · ${market.englishName}`
    : `${market.englishName} · ${market.kind === 'stock' || ['Asia/Hong_Kong', 'Asia/Shanghai'].includes(market.exchangeTimezone) ? market.symbol : market.key}`
  return (
    <button className={`market-card ${active ? 'active' : ''}${market.watchStance === 'bearish' ? ' bearish' : ''}`} onClick={onClick} aria-pressed={active}>
      <span className="card-accent" />
      <span className="market-card-top">
        <span>
          <strong>{market.name}</strong>
          <small title={`${market.englishName} · ${market.symbol}`}>{cardLabel}</small>
          {market.watchStance === 'bearish' && <span className="watch-stance-tag">看空关注</span>}
        </span>
        <span className={`direction ${positive ? 'up' : 'down'}`}>{market.change === null ? '暂无' : market.change === 0 ? '持平' : positive ? '上涨' : '下跌'}</span>
      </span>
      <span className="market-price-line">
        <span className="market-price">{formatMarketNumber(market.price, market)}</span>
        <small>{market.unit}</small>
      </span>
      <span className={`market-change ${positive ? 'up' : 'down'}`}>
        {formatMarketNumber(market.change, market, true)}
        <b>{market.changePercent === null ? '--' : signed.format(market.changePercent)}%</b>
      </span>
      <span className="range-row">
        {market.kind === 'fund' ? <span>每日净值 · {formatHistoryDate(market.marketTime)}</span> : market.key === 'CFETS' ? <span>{market.frequency || '官方定期发布'} · {formatHistoryDate(market.marketTime)}</span> : <>
          <span>低 {formatMarketNumber(market.dayLow, market)}</span>
          <span>高 {formatMarketNumber(market.dayHigh, market)}</span>
        </>}
      </span>
      {isRmbCurrencyMarket(market) && <span className="card-note">{currencyExchangeNote(market)}</span>}
      {market.kind !== 'fund' && market.key !== 'CFETS' && <span className="card-note">{market.marketTime ? market.dataGranularity === '1d' ? `日线收盘 ${formatHistoryDate(market.marketTime, market.exchangeTimezone)}` : `报价 ${formatChinaTime(market.marketTime, true)} · 北京时间` : market.dataGranularity === 'loading' ? '正在获取报价' : '报价暂不可用'}</span>}
      {market.isStale && market.price != null && <span className="card-note warning">{market.dataGranularity === '1d' ? '分时报价暂不可用 · 显示日线' : '更新暂不可用 · 显示缓存数据'}</span>}
    </button>
  )
}, (previous, next) => previous.market === next.market && previous.active === next.active)

export default function App() {
  const { data, loading, refreshing, error, refresh: load, refreshToken } = useMarketQuotes()
  const [selectedKey, setSelectedKey] = useState('NQ')
  const [period, setPeriod] = useState<Period>('MAX')
  const [now, setNow] = useState(new Date())
  const [goldUnit, setGoldUnit] = useState<GoldUnit>('USD')
  const [currencyDirection, setCurrencyDirection] = useState<CurrencyDirection>('USDCNY')
  const [euroCurrencyDirection, setEuroCurrencyDirection] = useState<CurrencyDirection>('EURCNY')

  function selectMarket(key: Market['key']) {
    if (key === 'HXC' || key === 'NF_DIV_LV50' || key === 'NF_DIV_LV50_A' || key === 'EURCNY') setPeriod('MAX')
    setSelectedKey(key)
  }

  useEffect(() => {
    const clockTimer = window.setInterval(() => setNow(new Date()), 1_000)
    return () => window.clearInterval(clockTimer)
  }, [])

  const displayMarkets = useMemo(
    () => {
      if (!data) return []
      const cashOpen = data.usCashSession?.isOpen ?? false
      const hidden = new Set(cashOpen ? ['NQ', 'ES', 'YM'] : ['NDX', 'SPX', 'DJI'])
      return data.markets
        .filter((market) => !hidden.has(market.key))
        .map((market) => convertCurrencyMarket(convertGoldMarket(market, goldUnit, data.fx?.rate), market.key === 'EURCNY' ? euroCurrencyDirection : currencyDirection))
    },
    [data, goldUnit, currencyDirection, euroCurrencyDirection],
  )
  const activeQuote = useMemo(
    () => displayMarkets.find((market) => market.key === selectedKey)
      || displayMarkets.find((market) => market.key === ({ NQ: 'NDX', NDX: 'NQ', ES: 'SPX', SPX: 'ES', YM: 'DJI', DJI: 'YM' } as Record<string, string>)[selectedKey])
      || displayMarkets[0],
    [displayMarkets, selectedKey],
  )
  const { history, loading: historyLoading, error: historyError } = useMarketHistory(activeQuote?.key, period, refreshToken)
  const activeMarket = useMemo(() => {
    const quote = data?.markets.find((market) => market.key === activeQuote?.key)
    if (!quote) return undefined
    return convertCurrencyMarket(convertGoldMarket(mergeQuoteAndHistory(quote, history), goldUnit, data?.fx?.rate), quote.key === 'EURCNY' ? euroCurrencyDirection : currencyDirection)
  }, [data, activeQuote?.key, history, goldUnit, currencyDirection, euroCurrencyDirection])
  const activeCurrencyPair = activeMarket && isRmbCurrencyMarket(activeMarket) ? rmbCurrencyPairs[activeMarket.key] : undefined
  const activeCurrencyDirection = activeMarket?.key === 'EURCNY' ? euroCurrencyDirection : currencyDirection
  const setActiveCurrencyDirection = activeMarket?.key === 'EURCNY' ? setEuroCurrencyDirection : setCurrencyDirection
  const companies = useMemo(() => displayMarkets.filter((market) => market.kind === 'stock'), [displayMarkets])
  const showTotalReturn = activeMarket?.key === 'NF_DIV_LV50' || activeMarket?.key === 'NF_DIV_LV50_A'
  const futuresSession = getSessionState(now)
  const cashSession = data?.usCashSession
    ? {
        phase: data.usCashSession.isOpen ? 'open' as const : 'weekend' as const,
        label: data.usCashSession.label,
        detail: data.usCashSession.detail,
      }
    : getCashSessionState(now)
  const session = activeMarket?.key === 'CFETS'
    ? { phase: 'weekend', label: '人民币汇率指数', detail: activeMarket.frequency || '官方定期发布' }
    : activeMarket?.kind === 'fund'
      ? { phase: 'weekend', label: '场外基金', detail: '每日披露净值 · 以最新净值日期为准' }
    : activeMarket?.exchangeTimezone === 'Asia/Hong_Kong'
      ? { phase: 'weekend', label: '港股行情', detail: '香港市场 · 以行情源报价时间为准' }
    : (activeMarket?.kind === 'stock' || activeMarket?.kind === 'index' || activeMarket?.kind === 'etf') && activeMarket.exchangeTimezone === 'Asia/Shanghai'
      ? { phase: 'weekend', label: activeMarket.kind === 'index' ? 'A股指数' : activeMarket.kind === 'etf' ? 'ETF行情' : 'A股行情', detail: `${activeMarket.exchange} · 以行情源报价时间为准` }
    : activeMarket?.kind === 'forex'
      ? { phase: 'weekend', label: activeMarket.key === 'EURCNY' ? '人民币外汇参考' : '在岸人民币外汇', detail: '以行情源报价时间为准' }
    : activeMarket?.kind === 'index' || activeMarket?.kind === 'stock'
    ? cashSession
    : activeMarket?.kind === 'metal' && futuresSession.phase === 'open'
      ? { ...futuresSession, label: '现货黄金交易中', detail: '全球黄金参考行情' }
      : futuresSession
  const latestTime = activeMarket?.marketTime || 0
  const ageSeconds = latestTime ? Math.max(0, Math.floor(now.getTime() / 1000 - latestTime)) : null
  const stale = Boolean(activeMarket?.isStale) || (ageSeconds !== null && ageSeconds > 180)

  return (
    <main>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><BarChart3 size={19} /></span>
          <div><h1>全球市场行情台</h1><p>GLOBAL MARKETS</p></div>
        </div>
        <div className="header-status">
          <div className={`session-status ${session.phase}`}><span />{session.label}<small>{session.detail}</small></div>
          <div className="clock"><Clock3 size={15} /><span>{activeMarket?.exchangeTimezone === 'Asia/Hong_Kong'
            ? `香港 ${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Hong_Kong', weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now)}`
            : activeMarket?.exchangeTimezone === 'Asia/Shanghai'
              ? `北京 ${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now)}`
            : `纽约 ${formatNewYorkTime(now)}`}</span></div>
          <button className="icon-button" onClick={load} disabled={refreshing} title="立即刷新" aria-label="立即刷新">
            <RefreshCw size={17} className={refreshing ? 'spin' : ''} />
          </button>
        </div>
      </header>

      <section className="workspace">
        <div className="section-heading">
          <div><p className="eyebrow">{data?.usCashSession?.isOpen ? '美股正盘 · 现金指数 · 个股' : '美股休市/未开盘 · 股指期货 · 个股'}</p><h2>主要市场一览</h2></div>
          <div className={`feed-status ${error ? 'warn' : stale ? 'stale' : ''}`}>
            {error ? <AlertCircle size={15} /> : stale ? <WifiOff size={15} /> : <Wifi size={15} />}
            <span>{error || (stale ? `最近报价 ${formatChinaTime(latestTime, true)} · 可能休市或延迟` : `${data?.delay || '延迟未知'} · 15秒刷新`)}</span>
          </div>
        </div>

        {loading && !data ? (
          <div className="loading-grid" aria-label="正在加载行情">{[1, 2, 3, 4, 5].map((item) => <div className="skeleton" key={item} />)}</div>
        ) : data ? (
          <div className="market-groups">
            {marketGroups.map((group) => {
              const markets = displayMarkets.filter(group.includes)
              const bearishMarkets = group.key === 'stocks' ? markets.filter((market) => market.watchStance === 'bearish') : []
              const regularMarkets = group.key === 'stocks' ? markets.filter((market) => market.watchStance !== 'bearish') : markets
              return <section className={`market-group${group.key === 'etfs' ? ' etf-group' : ''}`} key={group.key} aria-labelledby={`market-group-${group.key}`}>
                <div className="market-group-heading">
                  <div className="market-group-title"><h3 id={`market-group-${group.key}`}>{group.title}</h3><span className="market-group-count">{markets.length}</span></div>
                  <p className="market-group-caption">{group.caption}</p>
                </div>
                <div className="market-grid">
                  {regularMarkets.map((market) => (
                    <MarketCard key={market.key} market={market} active={activeMarket?.key === market.key} onClick={() => selectMarket(market.key)} />
                  ))}
                </div>
                {bearishMarkets.length > 0 && <section className="bearish-watch-group" aria-labelledby="bearish-watch-title">
                  <div className="market-group-heading">
                    <div className="market-group-title"><h4 id="bearish-watch-title">看空关注</h4><span className="market-group-count">{bearishMarkets.length}</span></div>
                    <p className="market-group-caption">按你的看空观点单独跟踪</p>
                  </div>
                  <div className="market-grid">
                    {bearishMarkets.map((market) => <MarketCard key={market.key} market={market} active={activeMarket?.key === market.key} onClick={() => selectMarket(market.key)} />)}
                  </div>
                </section>}
              </section>
            })}
          </div>
        ) : (
          <div className="empty-state"><AlertCircle /><h3>暂时无法获取行情</h3><p>{error}</p><button onClick={() => load()}>重新连接</button></div>
        )}

        {activeMarket && (
          <div className={showTotalReturn ? 'etf-chart-comparison' : undefined}>
          <section className="chart-panel">
            <div className="chart-header">
              <div className="chart-title">
                <span className="ticker-icon"><Activity size={18} /></span>
                <div><p>{activeMarket.symbol} · {activeMarket.exchange} · {activeMarket.unit}</p><h3>{activeMarket.name} {activeMarket.englishName}走势</h3>{activeMarket.kind === 'etf' && <span className="chart-basis-label">场内价格 · 不复权</span>}{activeMarket.kind === 'fund' && <span className="chart-basis-label">单位净值 · 未计入现金分红再投资</span>}</div>
              </div>
              <div className="chart-actions">
                {activeMarket.key === 'XAU' && (
                  <div className="unit-control" role="group" aria-label="黄金计价单位">
                    <button className={goldUnit === 'USD' ? 'selected' : ''} onClick={() => setGoldUnit('USD')}>USD/oz</button>
                    <button className={goldUnit === 'CNY' ? 'selected' : ''} onClick={() => setGoldUnit('CNY')}>CNY/g</button>
                  </div>
                )}
                {activeCurrencyPair && (
                  <div className="unit-control" role="group" aria-label={activeCurrencyPair.groupLabel}>
                    <button className={activeCurrencyDirection === activeCurrencyPair.forward ? 'selected' : ''} aria-pressed={activeCurrencyDirection === activeCurrencyPair.forward} onClick={() => setActiveCurrencyDirection(activeCurrencyPair.forward)}>{activeCurrencyPair.foreign} → 人民币</button>
                    <button className={activeCurrencyDirection === activeCurrencyPair.inverse ? 'selected' : ''} aria-pressed={activeCurrencyDirection === activeCurrencyPair.inverse} onClick={() => setActiveCurrencyDirection(activeCurrencyPair.inverse)}>人民币 → {activeCurrencyPair.foreign}</button>
                  </div>
                )}
                <div className="period-control" role="group" aria-label="走势图时间范围">
                  {periods.map((item) => (
                    <button key={item.value} className={period === item.value ? 'selected' : ''} onClick={() => setPeriod(item.value)}>{(activeMarket.key === 'CFETS' || activeMarket.kind === 'fund') && item.value === '1D' ? '最新' : item.label}</button>
                  ))}
                </div>
              </div>
            </div>
            <div className="chart-meta">
              <div><span>{activeMarket.kind === 'fund' ? '最新净值' : '最新'}（{activeMarket.unit}）</span><strong>{formatMarketNumber(activeMarket.price, activeMarket)}</strong></div>
              <div><span>{activeMarket.kind === 'fund' ? '前期净值' : activeMarket.key === 'CFETS' ? '上期' : '前收'}（{activeMarket.unit}）</span><strong>{formatMarketNumber(activeMarket.previousClose, activeMarket)}</strong></div>
              <div><span>{activeMarket.kind === 'fund' ? '更新频率' : activeMarket.key === 'CFETS' ? '发布频率' : '日内区间'}</span><strong>{activeMarket.kind === 'fund' ? '每日净值' : activeMarket.key === 'CFETS' ? activeMarket.frequency : `${formatMarketNumber(activeMarket.dayLow, activeMarket)} – ${formatMarketNumber(activeMarket.dayHigh, activeMarket)}`}</strong></div>
              <div><span>{activeMarket.kind === 'fund' ? '净值日期' : activeMarket.key === 'CFETS' ? '数据日期' : '数据时间（北京时间）'}</span><strong>{activeMarket.kind === 'fund' || activeMarket.key === 'CFETS' ? formatHistoryDate(activeMarket.marketTime) : formatChinaTime(activeMarket.marketTime, true)}</strong></div>
              <div><span>历史起点</span><strong>{formatHistoryDate(activeMarket.historyStart, activeMarket.kind === 'stock' ? activeMarket.exchangeTimezone : 'Asia/Shanghai')}</strong></div>
            </div>
            {(activeMarket.dataNote || activeMarket.sourceName || isRmbCurrencyMarket(activeMarket)) && (
              <div className="market-note">
                {isRmbCurrencyMarket(activeMarket) && <span>{currencyExchangeNote(activeMarket, true)}</span>}
                {activeMarket.dataNote && <span>{activeMarket.dataNote}</span>}
                {activeMarket.sourceName && (activeMarket.sourceUrl ? <a href={activeMarket.sourceUrl} target="_blank" rel="noreferrer">来源：{activeMarket.sourceName}</a> : <span>来源：{activeMarket.sourceName}</span>)}
              </div>
            )}
            {historyError && <p className="valuation-warning" role="status">{historyError}</p>}
            {historyLoading && <p className="valuation-explainer" role="status">正在加载所选市场的历史走势…</p>}
            <TrendChart market={activeMarket} period={period} loading={historyLoading} />
          </section>
          {showTotalReturn && <EtfTotalReturnPanel key={activeMarket.key} instrumentKey={activeMarket.key} fundCode={activeMarket.symbol.split('.')[0]} name={activeMarket.name} isOffExchange={activeMarket.kind === 'fund'} />}
          </div>
        )}
        {activeMarket && (activeMarket.kind === 'index' || activeMarket.kind === 'futures') && activeMarket.key !== 'CFETS' && <IndexConstituentsPanel key={activeMarket.key} indexKey={activeMarket.key} indexName={activeMarket.name} />}
        <FixedInvestmentPanel />
        <HousingPanel />
        <FundamentalsTable companies={companies} />
      </section>

      <footer>
        <span>行情源 {data?.feed || '公开行情'} · 延迟未知，仅供信息参考，不构成投资建议</span>
        <span>{data?.fx?.rate ? `USD/CNY ${data.fx.rate.toFixed(4)} · ` : ''}所选市场报价时间 {formatChinaTime(latestTime, true)} CST</span>
      </footer>
    </main>
  )
}
