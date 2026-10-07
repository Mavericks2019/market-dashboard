import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FUNDAMENTAL_INSTRUMENTS,
  calculateTrailingRevenue,
  createFundamentalsService,
  makeCnFundamentalRow,
  makeHkFundamentalRow,
  makeUsFundamentalRow,
} from './fundamentals.mjs'

const google = FUNDAMENTAL_INSTRUMENTS.find((item) => item.key === 'GOOGL')
const hsbc = FUNDAMENTAL_INSTRUMENTS.find((item) => item.key === 'HSBC')
const unitree = FUNDAMENTAL_INSTRUMENTS.find((item) => item.key === 'UNITREE')
const pdd = FUNDAMENTAL_INSTRUMENTS.find((item) => item.key === 'PDD')
const tencent = FUNDAMENTAL_INSTRUMENTS.find((item) => item.key === 'TENCENT')

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

test('NVIDIA TTM follows actual fiscal-year boundaries while aligning standardized quarters', () => {
  const nvidia = FUNDAMENTAL_INSTRUMENTS.find((item) => item.key === 'NVDA')
  const fiscalIncome = (end, start, value, type, standardized) => income(end, start, value, type, {
    SECUCODE: nvidia.secucode, STD_REPORT_DATE: standardized,
  })
  // Named fields and dates from NVDA.O's F10 reports; amounts in millions of USD.
  const fiscalRows = [
    fiscalIncome('2026-07-26', '2026-04-27', 96221, '单季报', '2026-06-30'),
    fiscalIncome('2026-07-26', '2026-01-26', 177837, '累计季报', '2026-06-30'),
    fiscalIncome('2026-04-26', '2026-01-26', 81615, '单季报', '2026-03-31'),
    fiscalIncome('2026-01-25', '2025-01-27', 215938, '年报', '2025-12-31'),
    fiscalIncome('2025-07-27', '2025-04-28', 46743, '单季报', '2025-06-30'),
    fiscalIncome('2025-07-27', '2025-01-27', 90805, '累计季报', '2025-06-30'),
    fiscalIncome('2025-04-27', '2025-01-27', 44062, '单季报', '2025-03-31'),
  ]
  const options = { ...revenueOptions, secucode: nvidia.secucode }
  assert.equal(calculateTrailingRevenue(fiscalRows, options), 302970)
  assert.equal(calculateTrailingRevenue(fiscalRows, { ...options, reportDate: '2026-03-31' }), 253491)
  assert.equal(calculateTrailingRevenue(fiscalRows, { ...options, reportDate: '2025-12-31' }), 215938)
  const row = makeUsFundamentalRow(nvidia, {
    SECUCODE: nvidia.secucode, STD_REPORT_DATE: '2026-06-30', REPORT_DATE: '2026-07-26',
    CURRENCY_ABBR: 'USD', TOTAL_MARKET_CAP: 5757490, PE_TTM: 29.85, DIVIDEND_RATE: 0.21817,
  }, fiscalRows)
  assert.equal(row.ps, 5757490 / 302970)
  assert.equal(row.dividendYield, 0.21817)

  const missingComparable = fiscalRows.filter((row) => row.STD_REPORT_DATE !== '2025-06-30')
  assert.equal(calculateTrailingRevenue(missingComparable, options), null)

  const fiscalGap = fiscalRows.map((row) => row.DATE_TYPE === '年报'
    ? { ...row, REPORT_DATE: '2026-01-24' } : row)
  assert.equal(calculateTrailingRevenue(fiscalGap, options), null)
  const wrongComparableStart = fiscalRows.map((row) => row.STD_REPORT_DATE === '2025-06-30'
    ? { ...row, START_DATE: '2025-01-28' } : row)
  assert.equal(calculateTrailingRevenue(wrongComparableStart, options), null)
  const mislabeledQuarter = fiscalRows.map((row) => row.DATE_TYPE === '累计季报'
    && row.STD_REPORT_DATE === '2026-06-30' ? { ...row, START_DATE: '2026-04-27' } : row)
  assert.equal(calculateTrailingRevenue(mislabeledQuarter, options), null)
})

test('US ratios use PB distinctly from PS and preserve unknown quote time', () => {
  const main = { SECUCODE: google.secucode, STD_REPORT_DATE: '2026-06-30', REPORT_DATE_ZCB: '2026-07-03', CURRENCY_ABBR: 'USD', TOTAL_MARKET_CAP: 2300, PE_TTM: -5, DIVIDEND_RATE: null, PB: 123, PB_MRQ: 456 }
  const row = makeUsFundamentalRow(google, main, incomeRows)
  assert.equal(row.pe, -5)
  assert.equal(row.pb, 123)
  assert.match(row.pbBasis, /MRQ.*2026-07-03/)
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
  const valuation = { SECUCODE: hsbc.secucode, CORRE_SECUCODE: hsbc.secucode, PE_TTM: 13, PS_TTM: 4, PB_MQR: 1.894397683384, PB_MRQ: 888, PB_LYR: 1.860174317066, REPORT_DATE: '2026-10-05' }
  const main = { SECUCODE: hsbc.secucode, REPORT_DATE: '2026-06-30', IS_CNY_CODE: '0', TOTAL_MARKET_CAP: 150000, ISSUED_COMMON_SHARES: 1000, DIVIDEND_TTM: 6 }
  const row = makeHkFundamentalRow(hsbc, valuation, main)
  assert.equal(row.dividendYield, 4)
  assert.equal(row.ps, 4)
  assert.equal(row.pb, 1.894397683384)
  assert.match(row.pbBasis, /MRQ/)
  assert.equal(row.valuationDate, '2026-10-05')
  assert.equal(row.reportDate, '2026-06-30')
  assert.equal(row.marketTime, null)
  assert.equal(makeHkFundamentalRow(hsbc, { ...valuation, PS_TTM: null }, main).ps, null)
  assert.equal(makeHkFundamentalRow(hsbc, valuation, { ...main, IS_CNY_CODE: undefined }).dividendYield, null)
  assert.equal(makeHkFundamentalRow(hsbc, valuation, { ...main, DIVIDEND_TTM: null }).dividendYield, null)
  assert.throws(() => makeHkFundamentalRow(hsbc, { ...valuation, CORRE_SECUCODE: '行业平均' }, main))
})

test('PDD P/S aligns USD ADS market cap with CNY revenue and labels source FX as an estimate', () => {
  const cnyIncome = incomeRows.map((row) => ({ ...row, SECUCODE: pdd.secucode, CURRENCY_ABBR: 'CNY' }))
  const main = {
    SECUCODE: pdd.secucode, STD_REPORT_DATE: '2026-06-30', CURRENCY_ABBR: 'CNY',
    SECURITY_TYPE: '美国存托凭证', TOTAL_MARKET_CAP: 2300, ISSUED_COMMON_SHARES: 100,
    EPS_TTM_CNY: 70, EPS_TTM_USD: 10, PE_TTM: 8.276, PB: 1.6865, DIVIDEND_RATE: null,
  }
  const row = makeUsFundamentalRow(pdd, main, cnyIncome)
  // 2300 USD * 7 CNY/USD / 230 CNY; no extra factor for the ADS ratio.
  assert.equal(row.ps, 70)
  assert.equal(row.pe, 8.276)
  assert.equal(row.pb, 1.6865)
  assert.equal(row.dividendYield, null)
  assert.match(row.psBasis, /TTM.*估算/)
  assert.match(row.note, /不等同实时汇率/)
  assert.match(row.sourceUrl, /code=PDD$/)
  for (const value of [undefined, null, '', 0, -10, Infinity]) {
    assert.equal(makeUsFundamentalRow(pdd, { ...main, EPS_TTM_USD: value }, cnyIncome).ps, null)
    assert.equal(makeUsFundamentalRow(pdd, { ...main, EPS_TTM_CNY: value }, cnyIncome).ps, null)
  }
  const mixed = cnyIncome.map((item) => item.DATE_TYPE === '年报' ? { ...item, CURRENCY_ABBR: 'USD' } : item)
  assert.equal(makeUsFundamentalRow(pdd, main, mixed).ps, null)
  assert.equal(makeUsFundamentalRow(pdd, { ...main, CURRENCY_ABBR: 'USD' }, cnyIncome).ps, null)
  assert.equal(makeUsFundamentalRow(pdd, { ...main, CURRENCY_ABBR: 'HKD' }, cnyIncome).ps, null)
})

test('Tencent uses its HK listing and HKD dividend units without bank-specific wording', () => {
  const valuation = {
    SECUCODE: tencent.secucode, CORRE_SECUCODE: tencent.secucode, REPORT_DATE: '2026-10-05',
    PE_TTM: 14.411491207863, PB_MQR: 2.941043282339, PS_TTM: 4.299488618609,
  }
  const main = {
    SECUCODE: tencent.secucode, REPORT_DATE: '2026-06-30', IS_CNY_CODE: '0',
    TOTAL_MARKET_CAP: 3846172166685, ISSUED_COMMON_SHARES: 9092605595, DIVIDEND_TTM: 5.3147973,
  }
  const row = makeHkFundamentalRow(tencent, valuation, main)
  assert.equal(row.symbol, '00700.HK')
  assert.equal(row.pe, valuation.PE_TTM)
  assert.equal(row.pb, valuation.PB_MQR)
  assert.equal(row.ps, valuation.PS_TTM)
  assert.equal(row.dividendYield, main.DIVIDEND_TTM / 423 * 100)
  assert.doesNotMatch(row.note, /银行/)
  assert.match(row.sourceUrl, /code=00700$/)
  assert.equal(makeHkFundamentalRow(tencent, valuation, { ...main, IS_CNY_CODE: '1' }).dividendYield, null)
  assert.match(makeHkFundamentalRow(hsbc, { ...valuation, SECUCODE: hsbc.secucode, CORRE_SECUCODE: hsbc.secucode }, { ...main, SECUCODE: hsbc.secucode }).note, /银行/)
})

test('A-share TTM ratios retain their valuation date, separate financial period and bearish label', () => {
  const valuation = {
    SECUCODE: unitree.secucode, TRADE_DATE: '2026-09-30 00:00:00',
    PE_TTM: 311.81079117, PS_TTM: 87.7594764, PE_LAR: 654.7947131, PB_MRQ: 63.25406282,
  }
  const main = { SECUCODE: unitree.secucode, REPORT_DATE: '2026-06-30 00:00:00' }
  const row = makeCnFundamentalRow(unitree, valuation, main)
  assert.equal(row.pe, 311.81079117)
  assert.equal(row.pb, 63.25406282)
  assert.match(row.pbBasis, /MRQ/)
  assert.equal(row.ps, 87.7594764)
  assert.equal(row.dividendYield, null)
  assert.equal(row.valuationDate, '2026-09-30')
  assert.equal(row.reportDate, '2026-06-30')
  assert.equal(row.marketTime, null)
  assert.equal(row.watchStance, 'bearish')
  assert.match(row.note, /缺失不代表零股息/)
  assert.equal(makeCnFundamentalRow(unitree, { ...valuation, PS_TTM: null }, main).ps, null)
  assert.equal(makeCnFundamentalRow(unitree, { ...valuation, PE_TTM: -5 }, main).pe, -5)
  assert.throws(() => makeCnFundamentalRow(unitree, { ...valuation, SECUCODE: 'OTHER.SH' }, main))
  assert.throws(() => makeCnFundamentalRow(unitree, valuation, { ...main, SECUCODE: 'OTHER.SH' }))
})

test('P/B preserves negative equity and distinguishes unavailable values from valid ratios', () => {
  const makers = [
    (pb) => makeUsFundamentalRow(google, { SECUCODE: google.secucode, PB: pb }, []),
    (pb) => makeHkFundamentalRow(hsbc, { SECUCODE: hsbc.secucode, CORRE_SECUCODE: hsbc.secucode, PB_MQR: pb }, { SECUCODE: hsbc.secucode }),
    (pb) => makeCnFundamentalRow(unitree, { SECUCODE: unitree.secucode, PB_MRQ: pb }, { SECUCODE: unitree.secucode }),
  ]
  for (const make of makers) {
    assert.equal(make('1.89').pb, 1.89)
    const negative = make(-161.2)
    assert.equal(negative.pb, -161.2)
    assert.match(negative.note, /净资产不为正，市净率不适用/)
    for (const missing of [null, undefined, '', ' ', '--', NaN, Infinity, 0, '0']) {
      const row = make(missing)
      assert.equal(row.pb, null)
      assert.match(row.note, /未提供有效市净率/)
    }
  }
  const mcd = FUNDAMENTAL_INSTRUMENTS.find((item) => item.key === 'MCD')
  const main = { SECUCODE: mcd.secucode, PB: -161.201155800821, EQUITY_JYBZ: -1023000000, BVPS: -1.445647202976 }
  assert.equal(makeUsFundamentalRow(mcd, main, []).pb, main.PB)
  // A zero ratio is only classified as N/A when source equity confirms it.
  const zeroWithNegativeEquity = makeUsFundamentalRow(mcd, { ...main, PB: 0 }, [])
  assert.equal(zeroWithNegativeEquity.pb, 0)
  assert.match(zeroWithNegativeEquity.note, /净资产不为正，市净率不适用/)
  assert.equal(makeUsFundamentalRow(mcd, { ...main, PB: 12 }, []).pb, null)
  assert.equal(makeUsFundamentalRow(mcd, { SECUCODE: mcd.secucode, PB: 0, BVPS: 0 }, []).pb, 0)
})

test('five-minute caching deduplicates concurrent requests and preserves successful data on failure', async () => {
  let time = 0
  let calls = 0
  let failing = false
  const fetchImpl = async (url) => {
    calls += 1
    if (failing) throw new Error('timeout')
    if (new URL(url).pathname.endsWith('/ZYZBAjaxNew')) {
      const code = new URL(url).searchParams.get('code')
      assert.ok(['SH688836', 'SZ000002'].includes(code))
      const secucode = code === 'SZ000002' ? '000002.SZ' : unitree.secucode
      return { ok: true, json: async () => ({ data: [{ SECUCODE: secucode, REPORT_DATE: '2026-06-30' }] }) }
    }
    const params = new URL(url).searchParams
    const secucode = params.get('filter').match(/SECUCODE="([^"]+)"/)[1]
    const report = params.get('reportName')
    let data
    if (report === 'RPT_VALUEANALYSIS_DET') data = [{ SECUCODE: secucode, PE_TTM: secucode === '000002.SZ' ? -3.05 : 311.81, PB_MRQ: 63.25, PS_TTM: 87.76, TRADE_DATE: '2026-09-30' }]
    else if (report.includes('HKCVALUE')) data = [{ SECUCODE: secucode, CORRE_SECUCODE: secucode, PE_TTM: 13, PB_MQR: 1.89, PS_TTM: 4, REPORT_DATE: '2026-10-05' }]
    else if (report.includes('HKF10')) data = [{ SECUCODE: secucode, IS_CNY_CODE: '0', TOTAL_MARKET_CAP: 150000, ISSUED_COMMON_SHARES: 1000, DIVIDEND_TTM: 6 }]
    else if (report.includes('DATA_MAININDICATOR')) data = [{ SECUCODE: secucode, STD_REPORT_DATE: '2026-06-30', CURRENCY_ABBR: 'USD', PE_TTM: 10, PB: 6.62, TOTAL_MARKET_CAP: 2300, DIVIDEND_RATE: null }]
    else data = incomeRows.map((row) => ({ ...row, SECUCODE: secucode, TOTAL_INCOME: row.OPERATE_INCOME }))
    return { ok: true, json: async () => ({ success: true, result: { data } }) }
  }
  const fetchFundamentals = createFundamentalsService({ fetchImpl, now: () => time })
  const [first, concurrent] = await Promise.all([fetchFundamentals(), fetchFundamentals()])
  assert.equal(calls, FUNDAMENTAL_INSTRUMENTS.length * 2)
  assert.strictEqual(first, concurrent)
  assert.equal(first.rows.length, FUNDAMENTAL_INSTRUMENTS.length)
  assert.equal(first.rows.find((row) => row.key === 'GOOGL').ps, 10)
  assert.equal(first.rows.find((row) => row.key === 'GOOGL').pb, 6.62)
  assert.equal(first.rows.find((row) => row.key === 'HSBC').pb, 1.89)
  assert.equal(first.rows.find((row) => row.key === 'UNITREE').pb, 63.25)
  assert.equal(first.rows.find((row) => row.key === 'UNITREE').ps, 87.76)
  assert.equal(first.rows.find((row) => row.key === 'UNITREE').watchStance, 'bearish')
  const vanke = first.rows.find((row) => row.key === 'VANKE')
  assert.equal(vanke.symbol, '000002.SZ')
  assert.equal(vanke.pe, -3.05)
  assert.equal(vanke.reportDate, '2026-06-30')
  assert.match(vanke.note, /亏损，市盈率不适用/)
  assert.equal(vanke.watchStance, 'bearish')
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
  assert.equal(stale.rows.find((row) => row.key === 'GOOGL').pb, 6.62)
  assert.equal(stale.rows.find((row) => row.key === 'HSBC').pb, 1.89)
  assert.equal(stale.rows.find((row) => row.key === 'UNITREE').pb, 63.25)
  assert.match(stale.rows[0].note, /上次成功数据/)
  assert.equal(first.rows[0].isStale, false)
})

test('first-load outage returns unavailable metrics, never fabricated zeros', async () => {
  const fetchFundamentals = createFundamentalsService({ fetchImpl: async () => { throw new Error('offline') } })
  const result = await fetchFundamentals()
  assert.equal(result.rows.length, FUNDAMENTAL_INSTRUMENTS.length)
  assert.ok(result.rows.every((row) => row.pe === null && row.pb === null && row.ps === null && row.dividendYield === null))
  assert.ok(result.rows.every((row) => /暂时不可用/.test(row.note)))
  assert.equal(result.rows.find((row) => row.key === 'UNITREE').watchStance, 'bearish')
})
