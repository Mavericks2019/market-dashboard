// Eastmoney's own public F10 pages document the named fields used here.
// HK: /PC_HKF10/pages/home/index.html (valuation comparison and main indicators).
// US: /PC_USF10/pages/index.html (main indicators and financial analysis).
// CN: /gzfx/detail/<code>.html uses RPT_VALUEANALYSIS_DET's PE_TTM/PB_MRQ/PS_TTM.
// Never interpret PB as PS, missing dividends as zero, or cumulative reports as quarters.

const DATA_API = 'https://datacenter.eastmoney.com/securities/api/data/v1/get'
const CACHE_TTL = 5 * 60_000
const REQUEST_TIMEOUT = 8_000

export const FUNDAMENTAL_INSTRUMENTS = [
  { key: 'BRKB', symbol: 'BRK.B', secucode: 'BRK_B.N', name: '伯克希尔哈撒韦B', englishName: 'Berkshire Hathaway B', region: 'US', insurance: true },
  { key: 'GOOGL', symbol: 'GOOGL', secucode: 'GOOGL.O', name: '谷歌A类股', englishName: 'Alphabet Class A', region: 'US' },
  { key: 'NVDA', symbol: 'NVDA', secucode: 'NVDA.O', name: '英伟达', englishName: 'NVIDIA', region: 'US' },
  { key: 'AAPL', symbol: 'AAPL', secucode: 'AAPL.O', name: '苹果', englishName: 'Apple', region: 'US' },
  { key: 'SPCX', symbol: 'SPCX', secucode: 'SPCX.O', name: 'SpaceX', englishName: 'SpaceX Class A', region: 'US' },
  { key: 'KO', symbol: 'KO', secucode: 'KO.N', name: '可口可乐', englishName: 'The Coca-Cola Company', region: 'US' },
  { key: 'MCD', symbol: 'MCD', secucode: 'MCD.N', name: '麦当劳', englishName: "McDonald's Corporation", region: 'US' },
  { key: 'PDD', symbol: 'PDD', secucode: 'PDD.O', name: '拼多多', englishName: 'PDD Holdings', region: 'US' },
  { key: 'HSBC', symbol: '00005.HK', secucode: '00005.HK', name: '汇丰控股', englishName: 'HSBC Holdings', region: 'HK', bank: true },
  { key: 'STAN', symbol: '02888.HK', secucode: '02888.HK', name: '渣打集团', englishName: 'Standard Chartered', region: 'HK', bank: true },
  { key: 'TENCENT', symbol: '00700.HK', secucode: '00700.HK', name: '腾讯控股', englishName: 'Tencent Holdings', region: 'HK' },
  { key: 'UNITREE', symbol: '688836.SH', secucode: '688836.SH', name: '宇树科技', englishName: 'Unitree Robotics', region: 'CN', watchStance: 'bearish' },
  { key: 'VANKE', symbol: '000002.SZ', secucode: '000002.SZ', name: '万科A', englishName: 'China Vanke A', region: 'CN', watchStance: 'bearish' },
]

function numeric(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function positive(value) {
  const result = numeric(value)
  return result !== null && result > 0 ? result : null
}

function nonnegative(value) {
  const result = numeric(value)
  return result !== null && result >= 0 ? result : null
}

function priceToBook(value, hasNonpositiveEquity = false) {
  const ratio = numeric(value)
  // An unqualified zero can be a missing-value sentinel. Keep it only when
  // the same report confirms nonpositive book value, for an N/A display.
  if (ratio === 0 && !hasNonpositiveEquity) return null
  if (ratio !== null && ratio > 0 && hasNonpositiveEquity) return null
  return ratio
}

function addBookValueNote(row, notes, hasNonpositiveEquity = false) {
  if (hasNonpositiveEquity || (row.pb !== null && row.pb < 0)) {
    notes.push('最新财报净资产不为正，市净率不适用')
    if (row.pb === null) notes.push('来源市净率缺失或与净资产口径不一致，数值暂不展示')
  } else if (row.pb === null) notes.push('来源暂未提供有效市净率')
}

function dateOnly(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null
}

function reportPeriodDate(row) {
  // F10 aligns fiscal periods with STD_REPORT_DATE. For example, Coca-Cola's
  // actual second-quarter end may be July 3 instead of calendar June 30.
  return dateOnly(row.STD_REPORT_DATE) || dateOnly(row.REPORT_DATE)
}

function currency(row) {
  return row.CURRENCY_ABBR || (row.CURRENCY === '美元' ? 'USD' : row.CURRENCY)
}

function usMarketCapInReportingCurrency(main) {
  // US F10 labels TOTAL_MARKET_CAP as USD, even when CURRENCY_ABBR describes
  // CNY financial statements. Its paired TTM EPS fields express the same ADS
  // earnings in CNY and USD, so their quotient supplies a matching conversion.
  // The cap already uses ADS units: do not multiply by PDD's 4 ordinary shares.
  const usdCap = positive(main.TOTAL_MARKET_CAP)
  if (main.CURRENCY_ABBR === 'USD') return usdCap
  if (main.CURRENCY_ABBR !== 'CNY' || usdCap === null) return null
  const cnyEps = positive(main.EPS_TTM_CNY)
  const usdEps = positive(main.EPS_TTM_USD)
  if (cnyEps === null || usdEps === null) return null
  const cnyPerUsd = positive(cnyEps / usdEps)
  return cnyPerUsd === null ? null : positive(usdCap * cnyPerUsd)
}

function previousYear(date) {
  return `${Number(date.slice(0, 4)) - 1}${date.slice(4)}`
}

function periodLength(row) {
  const start = dateOnly(row.START_DATE)
  const end = dateOnly(row.REPORT_DATE)
  return start && end ? (Date.parse(end) - Date.parse(start)) / 86_400_000 + 1 : NaN
}

function isCumulativePeriod(row, reportDate) {
  const quarter = reportDate.slice(5)
  const bounds = { '03-31': [75, 105], '06-30': [165, 200], '09-30': [255, 295], '12-31': [350, 380] }[quarter]
  const typeMatches = quarter === '12-31' ? row.DATE_TYPE === '年报'
    : row.DATE_TYPE === '累计季报' || (quarter === '03-31' && row.DATE_TYPE === '单季报')
  const days = periodLength(row)
  return bounds && typeMatches && days >= bounds[0] && days <= bounds[1]
}

/** TTM = latest YTD + previous full year - comparable previous YTD.
 * Only complete, aligned periods of this security in one currency are accepted.
 * Source-standardized periods identify matching fiscal quarters. Actual start/end
 * dates verify consecutive fiscal years, including 52/53-week years such as NVIDIA.
 * No extrapolation or use of single-quarter rows as cumulative periods.
 */
export function calculateTrailingRevenue(rows, { secucode, reportDate, revenueField, currencyCode = 'USD' }) {
  if (!reportDate || !Array.isArray(rows)) return null
  const year = reportDate.slice(0, 4)
  const valid = rows.filter((row) => row.SECUCODE === secucode
    && currency(row) === currencyCode && positive(row[revenueField]) !== null)
  const current = valid.find((row) => reportPeriodDate(row) === reportDate
    && isCumulativePeriod(row, reportDate))
  if (!current) return null
  if (reportDate.endsWith('-12-31') && current.DATE_TYPE === '年报') return numeric(current[revenueField])
  const priorYear = Number(year) - 1
  const annual = valid.find((row) => row.DATE_TYPE === '年报'
    && reportPeriodDate(row) === `${priorYear}-12-31`
    && isCumulativePeriod(row, `${priorYear}-12-31`)
    && Date.parse(dateOnly(current.START_DATE)) - Date.parse(dateOnly(row.REPORT_DATE)) === 86_400_000)
  if (!annual) return null
  const comparable = valid.find((row) => reportPeriodDate(row) === previousYear(reportDate)
    && dateOnly(row.START_DATE) === dateOnly(annual.START_DATE)
    && isCumulativePeriod(row, previousYear(reportDate))
    && Math.abs(periodLength(row) - periodLength(current)) <= 7)
  if (!comparable) return null
  const total = numeric(current[revenueField]) + numeric(annual[revenueField]) - numeric(comparable[revenueField])
  return positive(total)
}

function baseRow(instrument) {
  return {
    key: instrument.key,
    symbol: instrument.symbol,
    name: instrument.name,
    englishName: instrument.englishName,
    ...(instrument.watchStance ? { watchStance: instrument.watchStance } : {}),
    pe: null,
    pb: null,
    ps: null,
    dividendYield: null,
    marketTime: null,
    reportDate: null,
    valuationDate: null,
    sourceName: '东方财富 F10',
    sourceUrl: instrument.region === 'CN'
      ? `https://data.eastmoney.com/gzfx/detail/${instrument.secucode.split('.')[0]}.html`
      : instrument.region === 'HK'
      ? `https://emweb.securities.eastmoney.com/PC_HKF10/pages/home/index.html?code=${instrument.symbol.slice(0, 5)}`
      : `https://emweb.securities.eastmoney.com/PC_USF10/pages/index.html?code=${instrument.secucode.split('.')[0]}`,
    peBasis: 'TTM（近12个月）',
    pbBasis: 'MRQ（最新财报净资产）',
    psBasis: 'TTM（近12个月）',
    dividendBasis: '近12个月现金股息',
    note: '',
    isStale: false,
  }
}

export function makeUsFundamentalRow(instrument, main, financials) {
  if (main?.SECUCODE !== instrument.secucode) throw new Error('财务指标未返回对应公司')
  const row = baseRow(instrument)
  const notes = []
  row.reportDate = reportPeriodDate(main)
  row.pe = numeric(main.PE_TTM)
  const equity = numeric(main.EQUITY_JYBZ)
  const bookValuePerShare = numeric(main.BVPS)
  const hasNonpositiveEquity = (equity !== null && equity <= 0)
    || (bookValuePerShare !== null && bookValuePerShare <= 0)
  // US F10's PB_SOURCE explicitly defines PB as total market capitalization /
  // latest reported equity attributable to the parent. REPORT_DATE_ZCB is the
  // actual balance-sheet date, which can differ from standardized income dates.
  row.pb = priceToBook(main.PB, hasNonpositiveEquity)
  const bookValueDate = dateOnly(main.REPORT_DATE_ZCB)
  if (bookValueDate) row.pbBasis = `MRQ · ${bookValueDate}净资产`
  row.dividendYield = nonnegative(main.DIVIDEND_RATE)
  const marketCap = usMarketCapInReportingCurrency(main)
  const trailingRevenue = calculateTrailingRevenue(financials, {
    secucode: instrument.secucode,
    reportDate: row.reportDate,
    revenueField: instrument.insurance ? 'TOTAL_INCOME' : 'OPERATE_INCOME',
    currencyCode: main.CURRENCY_ABBR,
  })
  row.ps = marketCap !== null && trailingRevenue !== null ? marketCap / trailingRevenue : null
  row.psBasis = main.CURRENCY_ABBR === 'CNY' ? 'TTM · 按同源折算汇率估算' : 'TTM · 总市值÷近12个月收入'
  if (row.pe !== null && row.pe <= 0) notes.push('近12个月亏损，市盈率不适用')
  if (row.pe === null) notes.push('来源暂未提供市盈率')
  addBookValueNote(row, notes, hasNonpositiveEquity)
  if (row.ps === null) notes.push('近12个月完整同币种收入或市值不足，市销率暂无')
  else if (main.CURRENCY_ABBR === 'CNY') notes.push('市销率按同源人民币/美元TTM每股收益的换算比例估算，统一市值与收入币种；该比例不等同实时汇率')
  if (row.dividendYield === null) notes.push('来源未提供股息率，缺失不代表零股息')
  if (instrument.insurance) notes.push('收入含保险及其他业务，估值含投资损益影响')
  notes.push('来源未提供估值所用行情的时间')
  row.note = notes.join('；')
  return row
}

export function makeHkFundamentalRow(instrument, valuation, main) {
  if (valuation?.SECUCODE !== instrument.secucode || valuation?.CORRE_SECUCODE !== instrument.secucode
    || main?.SECUCODE !== instrument.secucode) throw new Error('财务指标未返回对应港股')
  const row = baseRow(instrument)
  row.pe = numeric(valuation.PE_TTM)
  // HK F10 uses the spelling PB_MQR for the column its page labels MRQ.
  // PB_LYR is the previous annual-report ratio and is not interchangeable.
  row.pb = priceToBook(valuation.PB_MQR)
  row.ps = positive(valuation.PS_TTM)
  row.valuationDate = dateOnly(valuation.REPORT_DATE)
  row.reportDate = dateOnly(main.REPORT_DATE)
  // The HK F10 page explicitly labels DIVIDEND_TTM in HKD when IS_CNY_CODE=0.
  // TOTAL_MARKET_CAP and ISSUED_COMMON_SHARES are the same page's current cap and
  // issued ordinary share count. Their quotient is the matching HKD share price.
  // Do not divide a dividend in USD by a HKD share price or reuse a different listing.
  const hkd = String(main.IS_CNY_CODE) === '0'
  const cap = hkd ? positive(main.TOTAL_MARKET_CAP) : null
  const shares = positive(main.ISSUED_COMMON_SHARES)
  const dividend = hkd ? nonnegative(main.DIVIDEND_TTM) : null
  row.dividendYield = cap !== null && shares !== null && dividend !== null ? dividend / (cap / shares) * 100 : null
  row.dividendBasis = '近12个月港元股息÷同源港元股价'
  const notes = instrument.bank ? ['银行收入口径与非金融企业不同，市销率不宜直接横向比较'] : []
  if (row.pe !== null && row.pe <= 0) notes.push('近12个月亏损，市盈率不适用')
  if (row.pe === null) notes.push('来源暂未提供市盈率')
  addBookValueNote(row, notes)
  if (row.ps === null) notes.push('来源暂未提供市销率')
  if (row.dividendYield === null) notes.push('同币种股息或股价不足，股息率暂无')
  notes.push('PE/PB/PS日期为来源公布的估值日；股息率使用财务页最新市值，未提供该行情时间')
  row.note = notes.join('；')
  return row
}

export function makeCnFundamentalRow(instrument, valuation, main) {
  if (valuation?.SECUCODE !== instrument.secucode || main?.SECUCODE !== instrument.secucode) {
    throw new Error('财务指标未返回对应A股')
  }
  const row = baseRow(instrument)
  row.sourceName = '东方财富估值 / F10'
  // The source exposes named trailing ratios, distinct from PE_LAR (static)
  // and PB_MRQ (book value). TRADE_DATE is the daily valuation date, not the
  // financial reporting date or a fabricated live quotation timestamp.
  row.pe = numeric(valuation.PE_TTM)
  row.pb = priceToBook(valuation.PB_MRQ)
  row.ps = positive(valuation.PS_TTM)
  row.valuationDate = dateOnly(valuation.TRADE_DATE)
  row.reportDate = dateOnly(main.REPORT_DATE)
  // RPT_VALUEANALYSIS_DET has no trailing cash-dividend-yield field. Unknown
  // zero-valued quote fields or pre-IPO distributions are not substituted.
  row.dividendYield = null
  row.dividendBasis = '近12个月现金股息 · 来源暂无'
  const notes = []
  if (row.pe !== null && row.pe <= 0) notes.push('近12个月亏损，市盈率不适用')
  if (row.pe === null) notes.push('来源暂未提供TTM市盈率')
  addBookValueNote(row, notes)
  if (row.ps === null) notes.push('来源暂未提供TTM市销率')
  notes.push('来源未提供近12个月股息率，缺失不代表零股息')
  notes.push('PE/PS为TTM口径，PB为最新财报净资产口径；交易日与财报期分别列示')
  row.note = notes.join('；')
  return row
}

export function createFundamentalsService({ fetchImpl = fetch, now = Date.now, ttl = CACHE_TTL } = {}) {
  let cached = null
  let refreshedAt = null
  let inFlight = null
  const lastGood = new Map()

  async function report(reportName, instrument, extra = {}) {
    const query = new URLSearchParams({
      reportName,
      columns: 'ALL',
      filter: `(SECUCODE="${instrument.secucode}")`,
      pageNumber: '1',
      pageSize: '24',
      sortColumns: 'REPORT_DATE',
      sortTypes: '-1',
      source: 'F10',
      client: 'PC',
      ...extra,
    })
    const response = await fetchImpl(`${DATA_API}?${query}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT) })
    if (!response.ok) throw new Error(`财务数据服务返回 ${response.status}`)
    const data = await response.json()
    if (data.code === 9201) return []
    if (data.success !== true || !Array.isArray(data.result?.data)) throw new Error('财务数据服务返回格式异常')
    return data.result.data
  }

  async function loadRow(instrument) {
    try {
      let row
      if (instrument.region === 'HK') {
        const [valuation, main] = await Promise.all([
          report('RPT_PCF10_INDUSTRY_HKCVALUE', instrument, {
            filter: `(SECUCODE="${instrument.secucode}")(CORRE_SECUCODE="${instrument.secucode}")`,
            pageSize: '1',
          }),
          report('RPT_HKF10_FN_MAININDICATORMAX', instrument, { pageSize: '1' }),
        ])
        row = makeHkFundamentalRow(instrument, valuation[0], main[0])
      } else if (instrument.region === 'CN') {
        const [securityCode, exchange] = instrument.secucode.split('.')
        if (!['SH', 'SZ'].includes(exchange)) throw new Error('不支持的A股交易所')
        const code = `${exchange}${securityCode}`
        const [valuation, financials] = await Promise.all([
          report('RPT_VALUEANALYSIS_DET', instrument, {
            sortColumns: 'TRADE_DATE', pageSize: '1', source: 'WEB', client: 'WEB',
          }),
          (async () => {
            const response = await fetchImpl(`https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/ZYZBAjaxNew?type=0&code=${code}`, {
              signal: AbortSignal.timeout(REQUEST_TIMEOUT),
            })
            if (!response.ok) throw new Error(`A股财务数据服务返回 ${response.status}`)
            const data = await response.json()
            if (!Array.isArray(data.data)) throw new Error('A股财务数据服务返回格式异常')
            return data.data
          })(),
        ])
        row = makeCnFundamentalRow(instrument, valuation[0], financials[0])
      } else {
        const [main, financials] = await Promise.all([
          report('RPT_USF10_DATA_MAININDICATOR', instrument, { pageSize: '1' }),
          report(instrument.insurance ? 'RPT_USF10_FN_IMAININDICATOR' : 'RPT_USF10_FN_GMAININDICATOR', instrument),
        ])
        row = makeUsFundamentalRow(instrument, main[0], financials)
      }
      const old = lastGood.get(instrument.key)
      const available = [row.pe, row.pb, row.ps, row.dividendYield].some((value) => value !== null)
      if (old && (!available
        || (old.valuationDate && row.valuationDate && row.valuationDate < old.valuationDate)
        || (old.reportDate && row.reportDate && row.reportDate < old.reportDate))) {
        return { ...old, isStale: true, note: `${old.note}；本次来源数据缺失或日期倒退，保留上次成功数据及其原始日期` }
      }
      if (available) lastGood.set(instrument.key, row)
      return row
    } catch {
      const old = lastGood.get(instrument.key)
      return old
        ? { ...old, isStale: true, note: `${old.note}；本次更新失败，保留上次成功数据` }
        : { ...baseRow(instrument), note: '财务数据暂时不可用，稍后自动重试；未将缺失数据视为零' }
    }
  }

  return async function fetchFundamentals({ force = false } = {}) {
    if (inFlight) return inFlight
    if (!force && cached && refreshedAt !== null && now() - refreshedAt < ttl) return cached
    inFlight = (async () => {
      const rows = await Promise.all(FUNDAMENTAL_INSTRUMENTS.map(loadRow))
      refreshedAt = now()
      cached = { asOf: Math.floor(refreshedAt / 1000), rows }
      return cached
    })()
    try { return await inFlight } finally { inFlight = null }
  }
}

export const fetchFundamentals = createFundamentalsService()
