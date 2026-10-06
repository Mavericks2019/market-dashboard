import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FUNDAMENTAL_INSTRUMENTS,
  calculateTrailingRevenue,
  createFundamentalsService,
  makeHkFundamentalRow,
  makeUsFundamentalRow,
} from './fundamentals.mjs'

const google = FUNDAMENTAL_INSTRUMENTS.find((item) => item.key === 'GOOGL')
const hsbc = FUNDAMENTAL_INSTRUMENTS.find((item) => item.key === 'HSBC')

function income(reportDate, startDate, value, type = '累计季报', overrides = {}) {
  return {
    SECUCODE: google.secucode,
    REPORT_DATE: `${reportDate} 00:00:00`,
    START_DATE: `${startDate} 00:00:00`,
    DATE_TYPE: type,
    CURRENCY_ABBR: 'USD',
    OPERATE_INCOME: value,
    ...overrides,
  }
}

const incomeRows = [
  income('2026-06-30', '2026-04-01', 70, '单季报'),
  income('2026-06-30', '2026-01-01', 120),
  income('2026-03-31', '2026-01-01', 50, '单季报'),
  income('2025-12-31', '2025-01-01', 200, '年报'),
  income('2025-12-31', '2025-10-01', 60, '单季报'),
  income('2025-06-30', '2025-04-01', 45, '单季报'),
  income('2025-06-30', '2025-01-01', 90),
]
const revenueOptions = { secucode: google.secucode, reportDate: '2026-06-30', revenueField: 'OPERATE_INCOME' }

test('TTM uses current cumulative + prior annual - prior cumulative, never double counts quarters', () => {
  assert.equal(calculateTrailingRevenue(incomeRows, revenueOptions), 230)
  assert.equal(calculateTrailingRevenue([...incomeRows, ...incomeRows], revenueOptions), 230)
})

test('TTM refuses missing periods, mixed currencies, or a different company', () => {
  const noComparable = incomeRows.filter((row) => !row.REPORT_DATE.startsWith('2025-06-30'))
  assert.equal(calculateTrailingRevenue(noComparable, revenueOptions), null)
  const wrongCurrency = incomeRows.map((row) => row.DATE_TYPE === '年报' ? { ...row, CURRENCY_ABBR: 'HKD' } : row)
  assert.equal(calculateTrailingRevenue(wrongCurrency, revenueOptions), null)
  const wrongCompany = incomeRows.map((row) => row.DATE_TYPE === '年报' ? { ...row, SECUCODE: 'OTHER.O' } : row)
  assert.equal(calculateTrailingRevenue(wrongCompany, revenueOptions), null)
})

test('TTM aligns source-standardized fiscal periods when actual quarter ends differ', () => {
  const coke = FUNDAMENTAL_INSTRUMENTS.find((item) => item.key === 'KO')
  const fiscalRows = [
    income('2026-07-03', '2026-04-04', 13380, '单季报', { SECUCODE: coke.secucode, STD_REPORT_DATE: '2026-06-30' }),
    income('2026-07-03', '2026-01-01', 25852, '累计季报', { SECUCODE: coke.secucode, STD_REPORT_DATE: '2026-06-30' }),
    income('2025-12-31', '2025-01-01', 47941, '年报', { SECUCODE: coke.secucode, STD_REPORT_DATE: '2025-12-31' }),
    income('2025-06-27', '2025-01-01', 23664, '累计季报', { SECUCODE: coke.secucode, STD_REPORT_DATE: '2025-06-30' }),
  ]
  const options = { ...revenueOptions, secucode: coke.secucode }
  assert.equal(calculateTrailingRevenue(fiscalRows, options), 50129)
  assert.equal(calculateTrailingRevenue(fiscalRows.map(({ STD_REPORT_DATE, ...row }) => row), options), null)
  const row = makeUsFundamentalRow(coke, {
    SECUCODE: coke.secucode, STD_REPORT_DATE: '2026-06-30', REPORT_DATE: '2026-07-03',
    CURRENCY_ABBR: 'USD', TOTAL_MARKET_CAP: 501290, PE_TTM: 26, DIVIDEND_RATE: 2.43,
  }, fiscalRows)
  assert.equal(row.reportDate, '2026-06-30')
  assert.equal(row.ps, 10)
})

test('annual report is already twelve months; insurance total income is supported', () => {
  assert.equal(calculateTrailingRevenue(incomeRows, { ...revenueOptions, reportDate: '2025-12-31' }), 200)
  const insurer = incomeRows.map((row) => ({ ...row, SECUCODE: 'BRK_B.N', CURRENCY: 'USD', CURRENCY_ABBR: undefined, TOTAL_INCOME: row.OPERATE_INCOME }))
  assert.equal(calculateTrailingRevenue(insurer, { ...revenueOptions, secucode: 'BRK_B.N', revenueField: 'TOTAL_INCOME' }), 230)
})

test('US ratios preserve negative PE, missing dividends and unknown quote time', () => {
  const main = { SECUCODE: google.secucode, STD_REPORT_DATE: '2026-06-30', CURRENCY_ABBR: 'USD', TOTAL_MARKET_CAP: 2300, PE_TTM: -5, DIVIDEND_RATE: null, PB: 123 }
  const row = makeUsFundamentalRow(google, main, incomeRows)
  assert.equal(row.pe, -5)
  assert.equal(row.ps, 10)
  assert.equal(row.dividendYield, null)
  assert.equal(row.marketTime, null)
  assert.equal(row.valuationDate, null)
  assert.match(row.note, /亏损/)
  assert.equal(makeUsFundamentalRow(google, { ...main, DIVIDEND_RATE: 0.25 }, incomeRows).dividendYield, 0.25)
  assert.equal(makeUsFundamentalRow(google, { ...main, DIVIDEND_RATE: 0 }, incomeRows).dividendYield, 0)
  assert.equal(makeUsFundamentalRow(google, { ...main, DIVIDEND_RATE: ' ' }, incomeRows).dividendYield, null)
  assert.equal(makeUsFundamentalRow(google, { ...main, CURRENCY_ABBR: 'HKD' }, incomeRows).ps, null)
})

test('HK yield uses explicitly HKD dividends and a same-source HKD price; PB never substitutes PS', () => {
  const valuation = { SECUCODE: hsbc.secucode, CORRE_SECUCODE: hsbc.secucode, PE_TTM: 13, PS_TTM: 4, PB_MQR: 999, REPORT_DATE: '2026-10-05' }
  const main = { SECUCODE: hsbc.secucode, REPORT_DATE: '2026-06-30', IS_CNY_CODE: '0', TOTAL_MARKET_CAP: 150000, ISSUED_COMMON_SHARES: 1000, DIVIDEND_TTM: 6 }
  const row = makeHkFundamentalRow(hsbc, valuation, main)
  assert.equal(row.dividendYield, 4)
  assert.equal(row.ps, 4)
  assert.equal(row.valuationDate, '2026-10-05')
  assert.equal(row.reportDate, '2026-06-30')
  assert.equal(row.marketTime, null)
  assert.equal(makeHkFundamentalRow(hsbc, { ...valuation, PS_TTM: null }, main).ps, null)
  assert.equal(makeHkFundamentalRow(hsbc, valuation, { ...main, IS_CNY_CODE: undefined }).dividendYield, null)
  assert.equal(makeHkFundamentalRow(hsbc, valuation, { ...main, DIVIDEND_TTM: null }).dividendYield, null)
  assert.throws(() => makeHkFundamentalRow(hsbc, { ...valuation, CORRE_SECUCODE: '行业平均' }, main))
})

test('five-minute caching deduplicates concurrent requests and preserves successful data on failure', async () => {
  let time = 0
  let calls = 0
  let failing = false
  const fetchImpl = async (url) => {
    calls += 1
    if (failing) throw new Error('timeout')
    const params = new URL(url).searchParams
    const secucode = params.get('filter').match(/SECUCODE="([^"]+)"/)[1]
    const report = params.get('reportName')
    let data
    if (report.includes('HKCVALUE')) data = [{ SECUCODE: secucode, CORRE_SECUCODE: secucode, PE_TTM: 13, PS_TTM: 4, REPORT_DATE: '2026-10-05' }]
    else if (report.includes('HKF10')) data = [{ SECUCODE: secucode, IS_CNY_CODE: '0', TOTAL_MARKET_CAP: 150000, ISSUED_COMMON_SHARES: 1000, DIVIDEND_TTM: 6 }]
    else if (report.includes('DATA_MAININDICATOR')) data = [{ SECUCODE: secucode, STD_REPORT_DATE: '2026-06-30', CURRENCY_ABBR: 'USD', PE_TTM: 10, TOTAL_MARKET_CAP: 2300, DIVIDEND_RATE: null }]
    else data = incomeRows.map((row) => ({ ...row, SECUCODE: secucode, TOTAL_INCOME: row.OPERATE_INCOME }))
    return { ok: true, json: async () => ({ success: true, result: { data } }) }
  }
  const fetchFundamentals = createFundamentalsService({ fetchImpl, now: () => time })
  const [first, concurrent] = await Promise.all([fetchFundamentals(), fetchFundamentals()])
  assert.equal(calls, FUNDAMENTAL_INSTRUMENTS.length * 2)
  assert.strictEqual(first, concurrent)
  assert.equal(first.rows.length, FUNDAMENTAL_INSTRUMENTS.length)
  assert.equal(first.rows.find((row) => row.key === 'GOOGL').ps, 10)
  time = 299_999
  assert.strictEqual(await fetchFundamentals(), first)
  assert.equal(calls, FUNDAMENTAL_INSTRUMENTS.length * 2)
  time = 300_001
  failing = true
  const stale = await fetchFundamentals()
  assert.equal(calls, FUNDAMENTAL_INSTRUMENTS.length * 4)
  assert.equal(stale.asOf, Math.floor(time / 1000))
  assert.ok(stale.rows.every((row) => row.isStale))
  assert.equal(stale.rows.find((row) => row.key === 'GOOGL').ps, 10)
  assert.match(stale.rows[0].note, /上次成功数据/)
  assert.equal(first.rows[0].isStale, false)
})

test('first-load outage returns unavailable metrics, never fabricated zeros', async () => {
  const fetchFundamentals = createFundamentalsService({ fetchImpl: async () => { throw new Error('offline') } })
  const result = await fetchFundamentals()
  assert.equal(result.rows.length, FUNDAMENTAL_INSTRUMENTS.length)
  assert.ok(result.rows.every((row) => row.pe === null && row.ps === null && row.dividendYield === null))
  assert.ok(result.rows.every((row) => /暂时不可用/.test(row.note)))
})
