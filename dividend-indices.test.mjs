import test from 'node:test'
import assert from 'node:assert/strict'
import { DIVIDEND_INDEX_INSTRUMENTS, createDividendIndicesAdapter, parseCsiDividendDaily, parseDividendDaily, parseDividendMinutes, selectDividendPoints } from './dividend-indices.mjs'

const instrument = DIVIDEND_INDEX_INSTRUMENTS.CSI_DIV
const time = (date) => Date.parse(date) / 1000
const csiRow = (tradeDate, close, extra = {}) => ({ indexCode: instrument.symbol, tradeDate, close, open: close, high: close + 1, low: close - 1, ...extra })
const official = (data) => ({ code: '200', success: true, data })
const eastmoney = (field, rows, extra = {}) => ({ rc: 0, data: { code: instrument.symbol, name: instrument.providerName, market: 1, [field]: rows, ...extra } })

test('validates exact price-index identity and rejects other indices and total-return codes', () => {
  assert.throws(() => parseCsiDividendDaily(official([csiRow('20260930', 100, { indexCode: 'H00922' })]), instrument), /代码/)
  assert.throws(() => parseDividendDaily(eastmoney('klines', ['2026-09-30,100,101,102,99'], { code: '000300' }), instrument), /身份/)
  assert.throws(() => parseDividendMinutes(eastmoney('trends', ['2026-09-30 15:00,100,101,102,99'], { name: '沪深300' }), instrument), /身份/)
})

test('normalizes valid daily dates, sorts and deduplicates while rejecting impossible OHLC and missing values', () => {
  const points = parseDividendDaily(eastmoney('klines', [
    '2026-09-30,100,101,102,99', '2026-09-29,98,99,100,97',
    '2026-09-30,101,102,103,100', '2026-02-30,99,100,101,98',
    '2026-09-28,100,101,99,98', '2026-09-27,100,101,102,103',
    '2026-09-26,100,,102,99', '2026-09-25,100,0,102,99',
  ]), instrument)
  assert.deepEqual(points.map((point) => [point.time, point.close]), [[time('2026-09-29'), 99], [time('2026-09-30'), 102]])
  assert.equal(points[0].volume, null)
})

test('uses published base level without invented OHLC; prelaunch levels are explicitly close-only', () => {
  const lowVol = DIVIDEND_INDEX_INSTRUMENTS.CSI_DIV_LV
  const payload = official([
    csiRow('20051230', 1009.34, { indexCode: lowVol.symbol }),
    csiRow('20060104', 1009.34, { indexCode: lowVol.symbol }),
    csiRow('20131219', 4650.81, { indexCode: lowVol.symbol }),
  ])
  const points = parseCsiDividendDaily(payload, lowVol)
  assert.deepEqual(points[0], { time: time('2005-12-30'), close: 1000, open: null, high: null, low: null, volume: null })
  assert.equal(points[1].close, 1009.34)
  assert.equal(points[1].open, null)
  assert.equal(points[2].open, 4650.81)
  const shortened = parseCsiDividendDaily(official([payload.data.at(-1)]), lowVol)
  assert.equal(shortened.length, 1, 'a baseline must not be injected across missing early history')
})

test('minute data requires a real local minute clock and retains its exact same-row price', () => {
  const quote = parseDividendMinutes(eastmoney('trends', [
    '2026-09-30 15:00,110,111,112,109', '2026-09-30 14:59,109,110,111,108',
    '2026-09-30 15:00,111,112,113,110', '2026-09-30,900,900,900,900',
    '2026-09-30 25:00,900,900,900,900',
  ], { preClose: 108 }), instrument)
  assert.equal(quote.points.length, 2)
  assert.equal(quote.points.at(-1).time, time('2026-09-30T15:00:00+08:00'))
  assert.equal(quote.points.at(-1).close, 112)
  assert.equal(quote.previousClose, 108)
  assert.throws(() => parseDividendMinutes(eastmoney('trends', ['2026-09-30,100,100,100,100']), instrument), /分时为空/)
})

test('periods use trading sessions for 1D/5D, retaining the full default history', () => {
  const points = [23, 24, 25, 28, 29, 30].map((day) => ({ time: time(`2026-09-${day}T15:00:00+08:00`), close: day }))
  assert.deepEqual(selectDividendPoints(points, '1D', true).map((row) => row.close), [30])
  assert.deepEqual(selectDividendPoints(points, '5D', true).map((row) => row.close), [24, 25, 28, 29, 30])
  assert.equal(selectDividendPoints(points, 'MAX'), points)
  assert.throws(() => selectDividendPoints(points, 'unknown'), /周期/)
})

function mockClient() {
  let clock = Date.parse('2026-10-06T00:00:00Z')
  let failed = new Set()
  let shortHistory = false
  const calls = []
  const fetchImpl = async (url) => {
    const kind = url.includes('index-perf') ? 'official' : url.includes('kline/get') ? 'daily' : url.includes('trends2/get') ? 'minutes' : 'unexpected'
    calls.push(kind)
    if (failed.has(kind) || kind === 'unexpected') throw new Error('upstream offline')
    const body = kind === 'official' ? official((shortHistory ? [] : [csiRow('20041231', 1000), csiRow('20050104', 981.56)]).concat([csiRow('20260929', 108), csiRow('20260930', 110)]))
      : kind === 'daily' ? eastmoney('klines', ['2026-09-29,108,108,109,107', '2026-09-30,110,110,111,109'])
        : eastmoney('trends', ['2026-09-29 15:00,108,108,109,107', '2026-09-30 14:59,110,110,111,109', '2026-09-30 15:00,110,111,112,109'], { preClose: 108 })
    return { ok: true, json: async () => body }
  }
  return {
    client: createDividendIndicesAdapter({ fetchImpl, now: () => clock }), calls,
    advance: (milliseconds) => { clock += milliseconds },
    fail: (...kinds) => { failed = new Set(kinds) },
    shorten: () => { shortHistory = true },
  }
}

test('deduplicates concurrent requests, uses independent quote/history TTLs, and matches snapshot clock to minute close', async () => {
  const mock = mockClient()
  const [a, b] = await Promise.all([mock.client.fetchTrend('CSI_DIV'), mock.client.fetchTrend('CSI_DIV', '1D')])
  assert.deepEqual(mock.calls.sort(), ['daily', 'minutes', 'official'])
  assert.equal(a.price, 111)
  assert.equal(a.previousClose, 108)
  assert.equal(a.change, 3)
  assert.equal(a.marketTime, time('2026-09-30T15:00:00+08:00'))
  assert.equal(a.isStale, false)
  assert.equal(a.historyStart, time('2004-12-31'))
  assert.equal(b.dataGranularity, '1m')
  assert.equal(b.points.length, 2)
  mock.advance(12_001)
  await mock.client.fetchTrend('CSI_DIV')
  assert.equal(mock.calls.length, 4)
  assert.equal(mock.calls.at(-1), 'minutes')
})

test('upstream outages preserve all cached history, price and original minute timestamp with stale marker', async () => {
  const mock = mockClient()
  const original = await mock.client.fetchTrend('CSI_DIV')
  mock.advance(300_001)
  mock.fail('official', 'daily', 'minutes')
  const stale = await mock.client.fetchTrend('CSI_DIV')
  assert.deepEqual(stale.points, original.points)
  assert.equal(stale.price, original.price)
  assert.equal(stale.marketTime, original.marketTime)
  assert.equal(stale.isStale, true)
  assert.match(stale.dataNote, /上游刷新失败/)
})

test('shrinking upstream history does not erase the previously loaded full history', async () => {
  const mock = mockClient()
  const original = await mock.client.fetchTrend('CSI_DIV')
  mock.advance(300_001)
  mock.shorten()
  const result = await mock.client.fetchTrend('CSI_DIV')
  assert.deepEqual(result.points, original.points)
  assert.equal(result.historyStart, time('2004-12-31'))
})

test('cold missing minutes fall back to real daily closes, never invented quote clocks or zeros', async () => {
  const mock = mockClient()
  mock.fail('minutes')
  const result = await mock.client.fetchTrend('CSI_DIV', '1D')
  assert.equal(result.price, 110)
  assert.equal(result.marketTime, time('2026-09-30'))
  assert.equal(result.dataGranularity, '1d')
  assert.equal(result.isStale, true)
  assert.match(result.dataNote, /时间仅为该交易日日期/)
  assert.equal(result.points.length, 1)
})

test('cold official-history failure labels the true available start; complete cold outage rejects', async () => {
  const mock = mockClient()
  mock.fail('official')
  const result = await mock.client.fetchTrend('CSI_DIV')
  assert.equal(result.historyStart, time('2026-09-29'))
  assert.equal(result.isStale, true)
  assert.match(result.dataNote, /当前可用历史从 2026-09-29 开始/)
  const offline = mockClient()
  offline.fail('official', 'daily', 'minutes')
  await assert.rejects(offline.client.fetchTrend('CSI_DIV'), /upstream offline/)
})
