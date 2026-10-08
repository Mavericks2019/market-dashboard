import test from 'node:test'
import assert from 'node:assert/strict'
import { createMarketScheduler, mergeMarketQuote } from './market-scheduler.mjs'

const flush = () => new Promise((resolve) => setImmediate(resolve))
const deferred = () => { let resolve; let reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail }); return { promise, resolve, reject } }
const placeholder = (key) => ({ key, symbol: key, name: key, price: null, previousClose: null, marketTime: null, points: [] })
const quote = (price = 100, marketTime = 100) => ({ price, previousClose: 90, marketTime, dayHigh: price, dayLow: 90 })
const history = (points = [{ time: 1, close: 10 }, { time: 2, close: 20 }]) => ({ ...placeholder('A'), ...quote(20, 2), points })
function setup(options = {}) {
  return createMarketScheduler({ instruments: { A: {}, B: {} }, quoteSources: [], loadHistory: async () => history(), makePlaceholder: placeholder, ...options })
}

test('quotes do not request any history or wait for a stalled unrelated source', async () => {
  const slow = deferred()
  let histories = 0
  const scheduler = setup({ loadHistory: async () => { histories++; return history() }, quoteSources: [
    { id: 'fast', keys: ['A'], load: async () => new Map([['A', quote()]]) },
    { id: 'slow', keys: ['B'], load: () => slow.promise },
  ] })
  const started = Date.now()
  const snapshot = await scheduler.quoteSnapshot({ waitMs: 20 })
  assert.ok(Date.now() - started < 500)
  assert.equal(snapshot.markets[0].price, 100)
  assert.equal(snapshot.markets[1].dataGranularity, 'loading')
  assert.deepEqual(snapshot.markets.map((market) => market.points), [[], []])
  assert.equal(histories, 0)
  slow.resolve(new Map([['B', quote(200, 101)]]))
  await flush()
  assert.equal((await scheduler.quoteSnapshot()).markets[1].price, 200)
})

test('cold history polls coalesce per key and period and never load unselected markets', async () => {
  const task = deferred()
  const calls = []
  const scheduler = setup({ loadHistory: (key, period) => { calls.push([key, period]); return task.promise } })
  assert.equal(scheduler.historySnapshot('A', 'MAX').pending, true)
  assert.equal(scheduler.historySnapshot('A', 'MAX').pending, true)
  await flush()
  assert.deepEqual(calls, [['A', 'MAX']])
  task.resolve(history())
  await flush()
  const complete = scheduler.historySnapshot('A', 'MAX')
  assert.equal(complete.market.points.length, 2)
  assert.equal(complete.updating, false)
  assert.equal(typeof complete.revision, 'string')
})

test('expired history returns immediately and preserves its original receipt time on failure', async () => {
  let time = 1_000_000
  let calls = 0
  const task = deferred()
  const scheduler = setup({ now: () => time, loadHistory: () => ++calls === 1 ? Promise.resolve(history()) : task.promise })
  scheduler.historySnapshot('A', 'MAX')
  await flush()
  const initial = scheduler.historySnapshot('A', 'MAX')
  time += 310_000
  const old = scheduler.historySnapshot('A', 'MAX')
  assert.equal(old.asOf, initial.asOf)
  assert.equal(old.updating, true)
  assert.deepEqual(old.market.points, initial.market.points)
  await flush()
  task.reject(new Error('upstream unavailable'))
  await flush()
  const failed = scheduler.historySnapshot('A', 'MAX')
  assert.equal(failed.market.isStale, true)
  assert.equal(failed.asOf, initial.asOf)
  assert.equal(failed.updating, false)
})

test('MAX updates cannot truncate the loaded past and middle-point corrections change revision', async () => {
  let calls = 0
  const scheduler = setup({ loadHistory: async () => history(++calls === 1
    ? [{ time: 1, close: 10 }, { time: 2, close: 20 }, { time: 3, close: 30 }]
    : [{ time: 2, close: 22 }, { time: 3, close: 30 }]) })
  scheduler.historySnapshot('A', 'MAX')
  await flush()
  const initial = scheduler.historySnapshot('A', 'MAX')
  assert.equal(scheduler.historySnapshot('A', 'MAX', { force: true }).updating, true)
  await flush()
  const updated = scheduler.historySnapshot('A', 'MAX')
  assert.deepEqual(updated.market.points, [{ time: 1, close: 10 }, { time: 2, close: 22 }, { time: 3, close: 30 }])
  assert.notEqual(updated.revision, initial.revision)
})

test('old history cannot replace a newer quote and an older quote cannot replace newer history', async () => {
  assert.equal(mergeMarketQuote({ ...history(), marketTime: 200, price: 200 }, quote(100, 100)).price, 200)
  const scheduler = setup({ quoteSources: [{ id: 'fast', keys: ['A'], load: async () => new Map([['A', quote(200, 200)]]) }] })
  await scheduler.quoteSnapshot()
  await flush()
  scheduler.historySnapshot('A', 'MAX')
  await flush()
  const chart = scheduler.historySnapshot('A', 'MAX')
  assert.equal(chart.market.price, 200)
  assert.equal(chart.market.marketTime, 200)
  assert.equal(chart.market.points.at(-1).close, 20)
  assert.equal((await scheduler.quoteSnapshot()).markets[0].price, 200)
})

test('failed quotes and regressing timestamps preserve the actual quote clock and mark stale', async () => {
  let call = 0
  const scheduler = setup({ quoteSources: [{ id: 'test', keys: ['A'], load: async () => {
    if (++call === 3) throw new Error('offline')
    return new Map([['A', quote(call === 1 ? 200 : 100, call === 1 ? 200 : 100)]])
  } }] })
  await scheduler.quoteSnapshot()
  await flush()
  await scheduler.quoteSnapshot({ force: true })
  await flush()
  let market = (await scheduler.quoteSnapshot()).markets[0]
  assert.equal(market.price, 200)
  assert.equal(market.marketTime, 200)
  assert.equal(market.isStale, true)
  await scheduler.quoteSnapshot({ force: true })
  await flush()
  market = (await scheduler.quoteSnapshot()).markets[0]
  assert.equal(market.marketTime, 200)
  assert.equal(market.isStale, true)
})
