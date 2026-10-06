import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchCnyTrend, parseCnyJsonp, parseCnyDayHistory, parseCnyMinuteHistory, parseCnyQuote, selectCnyPoints } from './cny-market.mjs'

test('Sina daily order is open/low/high/close, with strict dates and no synthetic zero prices', () => {
  const points = parseCnyDayHistory('2026-09-30,6.7050,6.7021,6.7091,6.7050,|2026-09-29,6.7080,6.7029,6.7120,6.7065|2026-09-29,6.7080,6.7029,6.7120,6.7066|2026-02-30,7,6,8,7|2026-09-28,7,6,8,0|2026-09-27,7,8,6,7')
  assert.equal(points.length, 2)
  assert.equal(points[0].close, 6.7066)
  assert.deepEqual(points[1], {
    time: Date.parse('2026-09-30T00:00:00+08:00') / 1000,
    open: 6.705, low: 6.7021, high: 6.7091, close: 6.705, volume: null,
  })
})

test('JSONP is parsed as data and never executed', () => {
  assert.equal(parseCnyJsonp('/* banner */ var _data=("hello");'), 'hello')
  assert.throws(() => parseCnyJsonp('var _data=(globalThis.bad = 1);'))
  assert.throws(() => parseCnyJsonp('unavailable'))
})

test('snapshot uses latest price, previous close, and explicit China timezone', () => {
  const result = parseCnyQuote('var hq_str_fx_susdcny="03:00:00,6.7,6.71,6.8,51,6.75,6.8,6.69,6.7,在岸人民币,0,0,0,备注,0,0,,2026-10-01";')
  assert.equal(result.price, 6.7)
  assert.equal(result.previousClose, 6.8)
  assert.equal(result.dayHigh, 6.8)
  assert.equal(result.marketTime, Date.parse('2026-10-01T03:00:00+08:00') / 1000)
  assert.ok(Math.abs(result.changePercent - (6.7 / 6.8 - 1) * 100) < 1e-10)
  assert.throws(() => parseCnyQuote('var hq_str_fx_susdcny="";'))
})

test('intraday selection retains overnight continuation and five distinct sessions', () => {
  const dates = ['2026-09-23 10:00:00', '2026-09-24 10:00:00', '2026-09-25 10:00:00', '2026-09-28 10:00:00', '2026-09-29 10:00:00', '2026-09-30 10:00:00', '2026-10-01 03:00:00']
  const points = parseCnyMinuteHistory(dates.map((d) => ({ d, o: '7', h: '7', l: '7', c: '7' })))
  assert.equal(selectCnyPoints(points, '1D').length, 2)
  assert.equal(selectCnyPoints(points, '5D').length, 6)
  assert.equal(selectCnyPoints(points, 'MAX').length, 7)
  assert.throws(() => selectCnyPoints(points, 'invalid'))
})

test('minute parser drops malformed dates, empty prices, and impossible OHLC', () => {
  const points = parseCnyMinuteHistory([
    { d: '2026-09-30 10:00:00', o: 7, h: 7.1, l: 6.9, c: 7 },
    { d: '2026-09-30 10:01:00', o: 7, h: 7.1, l: 6.9, c: '' },
    { d: '2026-09-30 10:02:00', o: 7, h: 7.1, l: 6.9, c: 8 },
    { d: '2026-09-30 25:00:00', o: 7, h: 7.1, l: 6.9, c: 7 },
    null,
  ])
  assert.equal(points.length, 1)
})

test('failed refresh preserves the last real quote timestamp and marks cached data stale', async () => {
  const originalFetch = globalThis.fetch
  const originalNow = Date.now
  let currentTime = originalNow()
  try {
    Date.now = () => currentTime
    globalThis.fetch = async (url) => new Response(url.includes('hq.sinajs')
      ? 'var hq_str_fx_susdcny="03:00:00,6.7,6.71,6.8,51,6.75,6.8,6.69,6.7,CNY,0,0,0,source,0,0,,2026-10-01";'
      : 'var _data=("1994-08-30,8.5,8.5,8.5,8.5|2026-09-29,6.8,6.7,6.9,6.8|2026-09-30,6.8,6.7,6.9,6.7");')
    const first = await fetchCnyTrend('MAX')
    assert.equal(first.isStale, false)
    assert.equal(first.points.length, 3)
    assert.equal(first.price, 6.7)
    currentTime += 10 * 60_000
    globalThis.fetch = async () => { throw new Error('upstream unavailable') }
    const fallback = await fetchCnyTrend('MAX')
    assert.equal(fallback.isStale, true)
    assert.equal(fallback.marketTime, first.marketTime)
    assert.equal(fallback.historyStart, first.historyStart)
    assert.deepEqual(fallback.points, first.points)
  } finally {
    globalThis.fetch = originalFetch
    Date.now = originalNow
  }
})
