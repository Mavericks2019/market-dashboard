import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeGlobalDailyRows, parseSinaGlobalQuote, parseTencentDividendQuote, parseDividendClosingQuote } from './server.mjs'
import { DIVIDEND_INDEX_INSTRUMENTS } from './dividend-indices.mjs'
import { fetchUsQuotes } from './us-markets.mjs'

test('European global snapshots use their source date and clock, not a legacy date field', () => {
  const values = '富时100指数,10458.5000,-83.19,-0.79,9/26/2025,2025-09-26,2026-10-07,23:35:29,10542.1800,10541.6900,10542.1800,10445.4200,0'.split(',')
  const result = parseSinaGlobalQuote(values)
  assert.equal(result.price, 10458.5)
  assert.equal(new Date(result.marketTime * 1000).toISOString(), '2026-10-07T15:35:29.000Z')
  values[7] = ''
  assert.throws(() => parseSinaGlobalQuote(values), /来源时间/)
})

test('Tencent dividend snapshot validates index identity and retains its quote timestamp', () => {
  const fields = Array(40).fill('')
  Object.assign(fields, { 1: '红利指数', 2: '000015', 3: '3318.43', 4: '3271.90', 30: '20261008151300', 33: '3324.43', 34: '3277.84' })
  const encode = () => `v_sh000015="${fields.join('~')}";`
  const result = parseTencentDividendQuote(encode(), DIVIDEND_INDEX_INSTRUMENTS.SSE_DIV)
  assert.equal(new Date(result.marketTime * 1000).toISOString(), '2026-10-08T07:13:00.000Z')
  fields[2] = '000922'
  assert.throws(() => parseTencentDividendQuote(encode(), DIVIDEND_INDEX_INSTRUMENTS.SSE_DIV), /身份校验/)
  fields[2] = '000015'
  fields[30] = ''
  assert.throws(() => parseTencentDividendQuote(encode(), DIVIDEND_INDEX_INSTRUMENTS.SSE_DIV), /时间缺失/)
})

test('official recent daily fallback remains explicitly dated and never claims to be intraday', () => {
  const payload = { code: '200', success: true, data: [
    { indexCode: 'H30269', tradeDate: '20260929', close: 100, open: 100, high: 101, low: 99 },
    { indexCode: 'H30269', tradeDate: '20260930', close: 102, open: 100, high: 103, low: 99 },
  ] }
  const quote = parseDividendClosingQuote(payload, DIVIDEND_INDEX_INSTRUMENTS.CSI_DIV_LV)
  assert.equal(quote.price, 102)
  assert.equal(quote.previousClose, 100)
  assert.equal(quote.dataGranularity, '1d')
  assert.equal(quote.isStale, true)
  assert.equal(new Date(quote.marketTime * 1000).toISOString().slice(0, 10), '2026-09-30')
  assert.match(quote.dataNote, /非盘中快照/)
})

test('global daily refresh merges by trading date, preserves inception and accepts corrected overlaps', () => {
  const stamp = (date) => Date.parse(date) / 1000
  const first = [stamp('1971-02-05T14:30:00Z'), 100, 100, 100, 100, 0]
  const old = [stamp('2026-09-21T13:30:00Z'), 200, 200, 200, 200, 0]
  const corrected = [stamp('2026-09-21T04:00:00Z'), 201, 201, 201, 201, 0]
  const latest = [stamp('2026-10-07T04:00:00Z'), 210, 210, 210, 210, 0]
  const result = mergeGlobalDailyRows([first, old], [corrected, latest])
  assert.equal(result.length, 3)
  assert.equal(result[1][4], 201)
  assert.equal(new Date(result[0][0] * 1000).toISOString(), '1971-02-05T14:30:00.000Z')
  assert.equal(result[1][0], old[0])
  assert.equal(new Date(result.at(-1)[0] * 1000).toISOString(), '2026-10-07T12:00:00.000Z')
  const newYorkDay = (time) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time * 1000))
  assert.equal(newYorkDay(result[0][0]), '1971-02-05')
  assert.equal(newYorkDay(result.at(-1)[0]), '2026-10-07')
  assert.deepEqual(mergeGlobalDailyRows(result, [latest]), result)
})

test('US forced quote refresh bypasses TTL and coalesces overlapping force requests', async () => {
  const original = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => {
    requests++
    const fields = Array(27).fill('0')
    Object.assign(fields, { 0: 'Apple', 1: String(100 + requests), 3: '2026-10-08 15:00:00', 26: '100' })
    return new Response(`var hq_str_gb_aapl="${fields.join(',')}";`)
  }
  try {
    const initial = await fetchUsQuotes({ force: true })
    assert.equal((await fetchUsQuotes()).get('AAPL').price, initial.get('AAPL').price)
    assert.equal(requests, 1)
    const [first, second] = await Promise.all([fetchUsQuotes({ force: true }), fetchUsQuotes({ force: true })])
    assert.equal(requests, 2)
    assert.equal(first.get('AAPL').price, 102)
    assert.equal(second.get('AAPL').price, 102)
  } finally { globalThis.fetch = original }
})
