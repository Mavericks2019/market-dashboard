import test from 'node:test'
import assert from 'node:assert/strict'
import { utils, write } from '@e965/xlsx'
import {
  createIndexConstituentsAdapter, parseNasdaqConstituents,
  parseCsiConstituents, parseCniConstituents, parseHsiConstituents,
  parseNikkeiConstituents, parseSp500Constituents, parseDowConstituents,
  parseFtseConstituents, parseDaxConstituents, parseKrxConstituents,
} from './index-constituents.mjs'

const AT = Date.parse('2026-10-08T12:00:00Z')
function nasdaq(count = 100) {
  return { iTotalRecords: count, iTotalDisplayRecords: count, aaData: Array.from({ length: count }, (_, i) => ({ Symbol: `S${i}`, Name: `Company ${i}` })) }
}
function response(payload) { return new Response(JSON.stringify(payload), { status: 200 }) }
function workbook(table) {
  const book = utils.book_new()
  utils.book_append_sheet(book, utils.aoa_to_sheet(table), 'Constituents')
  return write(book, { type: 'buffer', bookType: 'biff8' })
}
const CSI_HEADER = ['日期Date', '指数代码 Index Code', '指数名称', '英文名称', '成份券代码', '成份券名称', '英文名称', '交易所Exchange']

test('Nasdaq validates advertised total and retains share classes and temporary genuine members', () => {
  const payload = { iTotalRecords: 2, aaData: [{ Symbol: 'BRK.B', Name: 'Berkshire' }, { Symbol: '$WBD$', Name: '' }] }
  assert.deepEqual(parseNasdaqConstituents(payload, {}).map((row) => row.key), ['US:BRK.B', 'US:$WBD$'])
  assert.throws(() => parseNasdaqConstituents({ ...payload, iTotalRecords: 3 }, {}), /数量不完整/)
  assert.throws(() => parseNasdaqConstituents({ ...payload, aaData: [payload.aaData[0], payload.aaData[0]] }, {}), /重复/)
  assert.throws(() => parseNasdaqConstituents({ ...payload, iTotalDisplayRecords: 1 }, {}), /部分成分/)
})

test('CSI preserves B shares and Beijing listings and rejects wrong index or dates', () => {
  const table = [CSI_HEADER,
    ['20260930', '000001', '上证', '', '900948', '伊泰B股', 'YITAI', '上海证券交易所'],
    ['20260930', '000001', '上证', '', '920599', '同力', 'TONLY', '北京证券交易所'],
  ]
  const parsed = parseCsiConstituents(workbook(table), { symbol: '000001', count: 2 })
  assert.equal(parsed.holdingsDate, '2026-09-30')
  assert.deepEqual(parsed.rows.map((row) => row.secucode), ['900948.SH', '920599.BJ'])
  assert.throws(() => parseCsiConstituents(workbook(table), { symbol: '000015' }), /代码不匹配/)
  table[2][0] = '20260929'
  assert.throws(() => parseCsiConstituents(workbook(table), { symbol: '000001' }), /日期不一致/)
})

test('CNI detects pagination truncation and keeps leading zeros', () => {
  const payload = { code: 200, total: 1, data: { total: 1, rows: [{ dateStr: '2026-09-30', seccode: '000001', secname: '平安银行' }] } }
  assert.equal(parseCniConstituents(payload, { symbol: '399001', count: 1 }).rows[0].secucode, '000001.SZ')
  assert.throws(() => parseCniConstituents({ ...payload, total: 500, data: { ...payload.data, total: 500 } }, { symbol: '399001' }), /数量不完整/)
})

test('HSI merges by code rather than list position and isolates Hong Kong registry keys', () => {
  const payload = (rows, stamp = '2026-10-08 07:32:44') => ({ indexSeriesList: [{ seriesCode: 'hstech', constituentsDate: stamp, indexList: [{ constituentsCount: 2, constituentContent: rows }] }] })
  const cn = payload([{ code: '700', constituentName: '腾讯', isDummy: 'N' }, { code: '9988', constituentName: '阿里', isDummy: 'N' }])
  const en = payload([{ code: '09988', constituentName: 'Alibaba', isDummy: 'N' }, { code: '00700', constituentName: 'Tencent', isDummy: 'N' }])
  const parsed = parseHsiConstituents(cn, { count: 2 }, en)
  assert.equal(parsed.rows[0].key, 'HK:00700')
  assert.equal(parsed.rows[0].englishName, 'Tencent')
  assert.throws(() => parseHsiConstituents(cn, { count: 2 }, payload(en.indexSeriesList[0].indexList[0].constituentContent, '2026-10-07')), /中英文成分不一致/)
})

test('Nikkei CSV preserves alphanumeric Japanese tickers and quoted names', () => {
  const csv = Buffer.from('Date of Data,Code,Company Name\n"2026/10/08","285A","KIOXIA HOLDINGS CORP."\n"2026/10/08","7203","TOYOTA, INC."\nCopyright notice,,\n')
  const parsed = parseNikkeiConstituents(csv, { count: 2 })
  assert.deepEqual(parsed.rows.map((row) => row.key), ['JP:285A', 'JP:7203'])
  assert.equal(parsed.rows[1].name, 'TOYOTA, INC.')
  assert.throws(() => parseNikkeiConstituents(csv, { count: 225 }), /数量不完整/)
})

test('S&P third-party directory validates independent sector totals without inventing a holdings date', () => {
  const csv = Buffer.from('Symbol,Security\nBRK.B,Berkshire Hathaway\nAAPL,Apple\n')
  const sectors = Buffer.from('sector,count\nFinancials,1\nTechnology,1\n')
  const parsed = parseSp500Constituents(csv, sectors, { count: 2 })
  assert.equal(parsed.rows[0].key, 'US:BRK.B')
  assert.equal(parsed.holdingsDate, null)
  assert.throws(() => parseSp500Constituents(csv, Buffer.from('sector,count\nAll,503\n'), {}), /数量不完整/)
})

test('Dow parser rejects an ETF-derived list and incomplete pages', () => {
  const page = '<h1>Dow Jones Industrial Average Stocks List</h1><div>Total Stocks</div><div>2</div><table id="main-table"><thead><tr><th>Symbol</th><th>Company Name</th></tr></thead><tbody><tr><td>1</td><td><a>AAPL</a></td><td>Apple</td></tr><tr><td>2</td><td>MSFT</td><td>Microsoft</td></tr></tbody></table>'
  assert.equal(parseDowConstituents(Buffer.from(page), { count: 2 }).rows.length, 2)
  assert.throws(() => parseDowConstituents(Buffer.from(page + 'derived from the holdings'), { count: 2 }), /页面身份/)
  assert.throws(() => parseDowConstituents(Buffer.from(page), { count: 30 }), /指数规则/)
})

test('FTSE ticker punctuation is retained and DAX uses the home Xetra symbol', () => {
  const html = '<title>FTSE 100 Market overview | Hargreaves Lansdown</title><tr id="ls-row-RR.-L"><td>RR.</td><td data-s-name="Rolls-Royce &amp; Company"></td></tr>'
  const ftse = parseFtseConstituents(Buffer.from(html), { count: 1 })
  assert.equal(ftse.rows[0].key, 'GB:RR.')
  assert.equal(ftse.rows[0].name, 'Rolls-Royce & Company')
  const entry = { instrument: { entityType: 'STOCK', homeSymbol: 'HEN3', symbol: 'OTHER', name: 'Henkel' }, quote: { market: { nameExchange: 'Xetra' } } }
  assert.equal(parseDaxConstituents({ total: 1, list: [entry] }, { count: 1 }).rows[0].key, 'DE:HEN3')
  assert.throws(() => parseDaxConstituents({ total: 40, list: [entry] }, {}), /数量不完整/)
})

test('KRX compares complete member sets and retains leading zeros and new alphabetic tickers', () => {
  const first = { output: [{ isu_cd: '005930', isu_nm: 'SamsungElec' }, { isu_cd: '0030R0', isu_nm: 'Daishin Value REIT' }] }
  const second = { output: [...first.output].reverse() }
  const parsed = parseKrxConstituents(first, second, '20261008', { count: 2 })
  assert.deepEqual(parsed.rows.map((row) => row.key), ['KR:005930', 'KR:0030R0'])
  assert.equal(parsed.holdingsDate, '2026-10-08')
  assert.throws(() => parseKrxConstituents(first, { output: [first.output[0]] }, '20261008', {}), /目录不一致/)
  assert.throws(() => parseKrxConstituents(first, { output: [...first.output, { isu_cd: '005935', isu_nm: 'Samsung preferred' }] }, '20261008', {}), /数量不完整/)
})

test('KRX requests members using the official latest trading day instead of local today', async () => {
  const rows = Array.from({ length: 600 }, (_, i) => ({ isu_cd: String(i + 100000), isu_nm: `Company ${i}` }))
  const adapter = createIndexConstituentsAdapter({ now: () => AT, fetchImpl: async (url, options) => {
    if (url.includes('GenerateOTP')) return new Response(Buffer.from(new URL(url).searchParams.get('bld')).toString('base64'))
    const bld = Buffer.from(options.body.get('code'), 'base64').toString('utf8')
    if (bld === '/COM/market_date_t') return response({ DS1: [{ max_work_dt: '20261007' }] })
    assert.equal(options.body.get('schdate'), '20261007')
    assert.equal(options.body.get('idx_id'), 'KGG01P')
    return response({ output: rows })
  } })
  const result = await adapter.fetchIndexConstituents('KOSPI')
  assert.equal(result.total, 600)
  assert.equal(result.holdingsDate, '2026-10-07')
  assert.equal(adapter.getConstituent('KR:100000').market, 'KR')
  assert.equal(adapter.getConstituent('CN:100000'), null)
})

test('cache coalesces simultaneous index/future requests and registry accepts only verified symbols', async () => {
  let calls = 0
  let unblock
  const wait = new Promise((resolve) => { unblock = resolve })
  const adapter = createIndexConstituentsAdapter({ now: () => AT, fetchImpl: async (_url, options) => {
    calls++
    assert.equal(options.body.get('id'), 'NDX')
    await wait
    return response(nasdaq())
  } })
  const first = adapter.fetchIndexConstituents('NDX')
  const second = adapter.fetchIndexConstituents('NQ')
  unblock()
  const [index, future] = await Promise.all([first, second])
  assert.equal(calls, 1)
  assert.equal(index.total, 100)
  assert.equal(future.key, 'NQ')
  assert.equal(future.indexSymbol, 'NDX')
  assert.equal(adapter.getConstituent('US:S0').market, 'US')
  assert.equal(adapter.getConstituent('CN:S0'), null)
  assert.equal(adapter.getConstituent('US:UNREQUESTED'), null)
  await adapter.fetchIndexConstituents('NDX')
  assert.equal(calls, 1)
})

test('refresh failure retains a complete snapshot and separates retrieval time from request completion', async () => {
  let now = AT
  let calls = 0
  const adapter = createIndexConstituentsAdapter({ now: () => now, fetchImpl: async () => response(++calls === 1 ? nasdaq() : { ...nasdaq(), iTotalRecords: 101 }) })
  const initial = await adapter.fetchIndexConstituents('NDX')
  now += 7 * 3600_000
  const stale = await adapter.fetchIndexConstituents('NDX')
  assert.equal(stale.isStale, true)
  assert.equal(stale.total, 100)
  assert.equal(stale.asOf, now / 1000)
  assert.equal(stale.fetchedAt, initial.fetchedAt)
  assert.equal(stale.holdingsDate, initial.holdingsDate)
  assert.match(stale.note, /刷新失败/)
})

test('failed initial fetch is explicit unavailable and never registers partial data', async () => {
  const adapter = createIndexConstituentsAdapter({ now: () => AT, fetchImpl: async () => response({ ...nasdaq(10), iTotalRecords: 100 }) })
  const result = await adapter.fetchIndexConstituents('NDX')
  assert.equal(result.status, 'unavailable')
  assert.equal(result.total, null)
  assert.equal(result.rows.length, 0)
  assert.equal(adapter.getConstituent('US:S0'), null)
  await assert.rejects(adapter.fetchIndexConstituents('__proto__'), /不支持/)
})

test('Nasdaq skips unpublished dates with exact zero totals only', async () => {
  const requestedDates = []
  const adapter = createIndexConstituentsAdapter({ now: () => AT, fetchImpl: async (_url, options) => {
    requestedDates.push(options.body.get('tradeDate'))
    return response(requestedDates.length === 1 ? nasdaq(0) : nasdaq())
  } })
  const result = await adapter.fetchIndexConstituents('NDX')
  assert.deepEqual(requestedDates, ['2026-10-08', '2026-10-07'])
  assert.equal(result.holdingsDate, '2026-10-07')
})

test('manual membership refresh bypasses six-hour cache and coalesces index/future requests', async () => {
  let clock = AT
  let calls = 0
  let unblock
  const wait = new Promise((resolve) => { unblock = resolve })
  const adapter = createIndexConstituentsAdapter({ now: () => clock, fetchImpl: async () => {
    const call = ++calls
    if (call > 1) await wait
    const payload = nasdaq()
    if (call > 1) payload.aaData[0] = { Symbol: 'NEW', Name: 'New member' }
    return response(payload)
  } })
  const initial = await adapter.fetchIndexConstituents('NDX')
  clock += 60_000
  const cached = await adapter.fetchIndexConstituents('NDX')
  assert.equal(calls, 1)
  assert.equal(cached.fetchedAt, initial.fetchedAt)
  const forced = adapter.fetchIndexConstituents('NQ', { force: true })
  const duplicate = adapter.fetchIndexConstituents('NDX', { force: true })
  const normal = adapter.fetchIndexConstituents('NDX')
  clock += 1000
  unblock()
  const results = await Promise.all([forced, duplicate, normal])
  assert.equal(calls, 2)
  for (const result of results) {
    assert.equal(result.rows[0].symbol, 'NEW')
    assert.equal(result.fetchedAt, clock / 1000)
    assert.equal(result.asOf, clock / 1000)
    assert.equal(result.holdingsDate, '2026-10-08')
    assert.equal(result.isStale, false)
  }
  assert.equal(adapter.getConstituent('US:NEW').name, 'New member')
})

test('forced refresh retains the last complete membership when source dates regress and can retry immediately', async () => {
  let clock = AT
  let sourceDate = '2026-10-08'
  let calls = 0
  const adapter = createIndexConstituentsAdapter({ now: () => clock, fetchImpl: async () => {
    calls++
    return response({ code: 200, total: 100, data: { total: 100, rows: Array.from({ length: 100 }, (_, i) => ({
      dateStr: sourceDate, seccode: String(300001 + i), secname: `Company ${sourceDate} ${i}`,
    })) } })
  } })
  const initial = await adapter.fetchIndexConstituents('ChiNext')
  clock += 1000
  sourceDate = '2026-10-07'
  const stale = await adapter.fetchIndexConstituents('ChiNext', { force: true })
  assert.equal(stale.isStale, true)
  assert.equal(stale.holdingsDate, initial.holdingsDate)
  assert.equal(stale.fetchedAt, initial.fetchedAt)
  assert.equal(stale.asOf, clock / 1000)
  assert.deepEqual(stale.rows, initial.rows)
  assert.match(stale.reason, /日期倒退/)
  assert.equal(adapter.getConstituent('CN:300001').name, initial.rows[0].name)
  sourceDate = '2026-10-08'
  const recovered = await adapter.fetchIndexConstituents('ChiNext', { force: true })
  assert.equal(calls, 3)
  assert.equal(recovered.isStale, false)
  assert.equal(recovered.reason, undefined)
  assert.equal(recovered.fetchedAt, clock / 1000)
})
