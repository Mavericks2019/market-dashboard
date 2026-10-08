import test from 'node:test'
import assert from 'node:assert/strict'
import { keepLatestQuote, mergeMarketSnapshot, mergeQuoteAndHistory, retainPoints } from './src/marketData.ts'

const point = (time, close) => ({ time, close, open: null, high: null, low: null, volume: null })
const old = { key: 'HXC', price: 100, previousClose: 99, change: 1, changePercent: 1.01, dayHigh: 101, dayLow: 98, marketTime: 1000, points: [point(100, 80), point(900, 100)], historyStart: 100 }

test('a slow or failed quote response never replaces a newer price with an older timestamp', () => {
  const prior = { ...old, price: 110, marketTime: 1100 }
  const retained = keepLatestQuote(prior, old)
  assert.equal(retained.price, 110)
  assert.equal(retained.marketTime, 1100)
  assert.equal(retained.isStale, true)
  assert.equal(keepLatestQuote(prior, { ...old, marketTime: null, price: null }).price, 110)
  assert.equal(keepLatestQuote(prior, { ...old, marketTime: 1200, price: 112 }).price, 112)
  assert.equal(keepLatestQuote(prior, { ...old, key: 'NDX' }).price, 100)
})

test('lightweight snapshots retain per-symbol freshness without introducing historical arrays', () => {
  const next = { markets: [{ ...old, points: [], marketTime: 900 }], asOf: 1500 }
  const result = mergeMarketSnapshot({ markets: [old] }, next)
  assert.equal(result.markets[0].marketTime, 1000)
  assert.deepEqual(result.markets[0].points, [])
  assert.equal(result.asOf, 1500)
})

test('quote updates combine with only the matching selected history and retain its full extent', () => {
  const current = { ...old, price: 110, marketTime: 1200, points: [] }
  const result = mergeQuoteAndHistory(current, old)
  assert.equal(result.price, 110)
  assert.equal(result.marketTime, 1200)
  assert.equal(result.points, old.points)
  assert.equal(result.historyStart, 100)
  assert.deepEqual(mergeQuoteAndHistory(current, { ...old, key: 'NDX' }).points, [])
  assert.equal(mergeQuoteAndHistory(old, { ...old, price: 115, marketTime: 1300 }).price, 115)
})

test('unchanged histories keep chart references but historical corrections and appended bars are accepted', () => {
  const same = old.points.map((p) => ({ ...p }))
  assert.equal(retainPoints(old.points, same), old.points)
  const corrected = [point(100, 81), point(900, 100)]
  assert.equal(retainPoints(old.points, corrected), corrected)
  const appended = [...same, point(1000, 102)]
  assert.equal(retainPoints(old.points, appended), appended)
})
