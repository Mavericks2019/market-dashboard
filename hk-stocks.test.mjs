import test from 'node:test'
import assert from 'node:assert/strict'
import { createHkStocksAdapter, parseHkDailyRows, parseHkMinuteSessions, parseHkStockQuotes } from './hk-stocks.mjs'

const dayRows = [['1980-01-02', '9', '10', '11', '8', '100'], ['2026-10-05', '100', '101', '102', '99', '200']]
const currentRow = ['2026-10-06', '103', '104', '105', '102', '300']
const quoteText = ['00005', '02888', '00700'].map((symbol) => `var hq_str_rt_hk${symbol}="NAME,中文,103,101,105,102,104,3,2.97,103,104,30000,300,12,0,120,80,2026/10/06,09:40:30";`).join('\n')
const responses = (url) => {
  if (url.includes('sinajs')) return new Response(quoteText)
  const symbol = url.match(/hk\d{5}/)[0]
  if (url.includes('fqkline')) {
    return new Response(JSON.stringify({ code: 0, data: { [symbol]: { day: [currentRow] } } }))
  }
  return new Response(JSON.stringify({ code: 0, data: { [symbol]: { data: [
    { date: '20261006', data: ['0931 104 30', '0930 103 20'] },
    { date: '20261005', data: ['0930 101 10'] },
  ] } } }))
}

test('daily rows preserve dates, sort/deduplicate, and reject invalid prices and dates', () => {
  const rows = parseHkDailyRows([
    ...dayRows.toReversed(), [...dayRows[0].slice(0, 2), '10.5', '11', '8', ''],
    ['2026-02-30', '1', '1', '1', '1', '1'], ['2026-10-04', '1', '', '1', '1', '1'],
  ])
  assert.equal(rows.length, 2)
  assert.equal(new Date(rows[0].time * 1000).toISOString(), '1980-01-02T00:00:00.000Z')
  assert.equal(rows[0].close, 10.5)
  assert.equal(rows[0].volume, null)
})

test('minute sessions use Hong Kong time, order rows, and convert cumulative volume', () => {
  const points = parseHkMinuteSessions([{ date: '20261006', data: ['0931 104 30', '0930 103 20', '0931 105 40', '2960 3 50'] }])
  assert.equal(points.length, 2)
  assert.equal(new Date(points[0].time * 1000).toISOString(), '2026-10-06T01:30:00.000Z')
  assert.deepEqual(points.map((point) => point.volume), [20, 20])
  assert.equal(points[1].close, 105)
  assert.equal(points[0].open, null)
})

test('quotes retain source time and do not accept missing times or empty prices', () => {
  const quotes = parseHkStockQuotes(quoteText)
  assert.equal(quotes.get('HSBC').price, 104)
  assert.equal(quotes.get('HSBC').previousClose, 101)
  assert.equal(new Date(quotes.get('HSBC').marketTime * 1000).toISOString(), '2026-10-06T01:40:30.000Z')
  assert.equal(parseHkStockQuotes(quoteText.replaceAll(',09:40:30', ',')).size, 0)
})

test('MAX keeps old history when refreshing a short window; periods share true start and fresh quote', async () => {
  const adapter = createHkStocksAdapter({ fetchImpl: async (url) => responses(url), loadHistory: async () => ({ rows: dayRows }) })
  const [max, day, week] = await Promise.all(['MAX', '1D', '5D'].map((period) => adapter.fetchTrend('HSBC', period)))
  assert.equal(max.points.length, 3)
  assert.equal(day.points.length, 2)
  assert.equal(week.points.length, 3)
  assert.equal(day.dataGranularity, '1m')
  assert.equal(max.historyStart, day.historyStart)
  assert.equal(day.historyStart, week.historyStart)
  assert.equal(max.price, 104)
  assert.equal(max.previousClose, 101)
  assert.equal(max.isStale, false)
})

test('Tencent requests its own quote and minute series without replacing IPO history', async () => {
  const requests = []
  const ipoRow = ['2004-06-16', '4.375', '4.150', '4.625', '4.075', '439775000']
  const adapter = createHkStocksAdapter({
    fetchImpl: async (url) => { requests.push(url); return responses(url) },
    loadHistory: async (symbol) => {
      assert.equal(symbol, '00700')
      return { rows: [ipoRow] }
    },
  })
  const [max, day, week] = await Promise.all(['MAX', '1D', '5D'].map((period) => adapter.fetchTrend('TENCENT', period)))
  assert.equal(max.symbol, '00700.HK')
  assert.equal(max.points.length, 2)
  assert.equal(max.points[0].close, 4.15)
  assert.equal(new Date(max.historyStart * 1000).toISOString().slice(0, 10), '2004-06-16')
  assert.equal(day.dataGranularity, '1m')
  assert.equal(day.points.length, 2)
  assert.equal(week.points.length, 3)
  assert.equal(max.price, 104)
  assert.equal(max.isStale, false)
  assert.ok(requests.some((url) => url.includes('list=') && url.includes('rt_hk00700')))
  assert.ok(requests.some((url) => url.includes('param=hk00700,day')))
  assert.ok(requests.some((url) => url.includes('code=hk00700')))
})

test('network failure uses bundled history, marks stale, and labels daily intraday fallback', async () => {
  const adapter = createHkStocksAdapter({ fetchImpl: async () => { throw new Error('offline') }, loadHistory: async () => ({ rows: dayRows }) })
  const market = await adapter.fetchTrend('HSBC', '1D')
  assert.equal(market.isStale, true)
  assert.equal(market.dataGranularity, '1d')
  assert.equal(market.points.length, 1)
  assert.equal(market.price, 101)
  assert.match(market.dataNote, /分时源暂不可用/)
})

test('failed refresh preserves last successful history and quote timestamp; no cache rejects', async () => {
  let offline = false
  let time = 1_000
  const adapter = createHkStocksAdapter({ fetchImpl: async (url) => { if (offline) throw new Error('offline'); return responses(url) }, now: () => time, loadHistory: async () => ({ rows: dayRows }) })
  const first = await adapter.fetchTrend('HSBC', 'MAX')
  offline = true
  time += 600_000
  const stale = await adapter.fetchTrend('HSBC', 'MAX')
  assert.equal(stale.isStale, true)
  assert.equal(stale.marketTime, first.marketTime)
  assert.deepEqual(stale.points, first.points)
  const empty = createHkStocksAdapter({ fetchImpl: async () => { throw new Error('offline') }, loadHistory: async () => { throw new Error('missing cache') } })
  await assert.rejects(empty.fetchTrend('HSBC', 'MAX'))
})
