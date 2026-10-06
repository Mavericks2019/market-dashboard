import test from 'node:test'
import assert from 'node:assert/strict'
import { createMainlandStocksAdapter, parseMainlandDailyRows, parseMainlandMinuteSessions, parseMainlandStockQuote } from './mainland-stocks.mjs'

const daily = [['2026-08-19', '1100', '845', '1100', '800', '1000'], ['2026-09-29', '460', '451.02', '461.5', '450.7', '100'], ['2026-09-30', '451.99', '450.4', '459.9', '446.5', '200']]
const quoteFields = ['宇树科技', '451.99', '451.02', '450.4', '459.9', '446.5', '450.29', '450.4', '200', ...Array(21).fill('0'), '2026-09-30', '15:34:59']
const quoteText = `var hq_str_sh688836="${quoteFields.join(',')}";`
const quoteBytes = Buffer.concat([Buffer.from('var hq_str_sh688836="'), Buffer.from('d3eecaf7bfc6bcbc', 'hex'), Buffer.from(`,${quoteFields.slice(1).join(',')}";`)])
const qt = { sh688836: ['1', '宇树科技-W', '688836'] }
const response = (url) => {
  if (url.includes('sinajs')) return new Response(quoteBytes)
  const data = url.includes('fqkline') ? { day: daily, qt } : { qt, data: [
    { date: '20260930', data: ['0931 450.4 40', '0930 451.99 10'] },
    { date: '20260929', data: ['0930 460 10'] },
  ] }
  return Response.json({ code: 0, data: { sh688836: data } })
}

test('daily bars reject pre-IPO, malformed dates and prices, and preserve UTC calendar dates', () => {
  const points = parseMainlandDailyRows([
    ...daily.toReversed(), ['2026-08-18', '1', '2', '3', '1', '10'],
    ['2026-09-31', '1', '2', '3', '1', '10'], ['2026-09-27', '1', '', '3', '1', '10'],
    ['2026-09-30', '451.99', '451', '459.9', '446.5', ''],
  ], '2026-08-19')
  assert.equal(points.length, 3)
  assert.equal(new Date(points[0].time * 1000).toISOString(), '2026-08-19T00:00:00.000Z')
  assert.equal(points.at(-1).close, 451)
  assert.equal(points.at(-1).volume, null)
})

test('minute bars use Shanghai time, sort and deduplicate, and reset cumulative volume each session', () => {
  const points = parseMainlandMinuteSessions([
    { date: '20260930', data: ['0931 451 30', '0930 450 10', '0931 452 40', '2460 452 50'] },
    { date: '20260929', data: ['0930 460 500'] },
  ])
  assert.equal(points.length, 3)
  assert.deepEqual(points.map((point) => point.volume), [500, 10, 30])
  assert.equal(new Date(points[1].time * 1000).toISOString(), '2026-09-30T01:30:00.000Z')
  assert.equal(points.at(-1).close, 452)
})

test('snapshot verifies issuer identity and retains actual quote time', () => {
  const quote = parseMainlandStockQuote(quoteText)
  assert.equal(quote.price, 450.4)
  assert.equal(quote.previousClose, 451.02)
  assert.equal(new Date(quote.marketTime * 1000).toISOString(), '2026-09-30T07:34:59.000Z')
  assert.throws(() => parseMainlandStockQuote(quoteText.replace('宇树科技', '另一家公司')), /身份/)
  assert.throws(() => parseMainlandStockQuote(quoteText.replace('15:34:59', '')), /时间/)
})

test('MAX and intraday share full IPO history while coalescing concurrent requests', async () => {
  const requests = []
  const adapter = createMainlandStocksAdapter({ fetchImpl: async (url) => { requests.push(url); return response(url) } })
  const [max, day, week] = await Promise.all(['MAX', '1D', '5D'].map((period) => adapter.fetchTrend('UNITREE', period)))
  assert.equal(requests.length, 3)
  assert.equal(max.points.length, 3)
  assert.equal(day.points.length, 2)
  assert.equal(week.points.length, 3)
  assert.equal(day.dataGranularity, '1m')
  assert.equal(max.dataGranularity, '1d')
  assert.equal(day.historyStart, max.historyStart)
  assert.equal(max.isStale, false)
  assert.equal(max.watchStance, 'bearish')
  assert.equal(max.price, 450.4)
})

test('historical pagination reaches IPO instead of silently accepting a recent window', async () => {
  let pages = 0
  const adapter = createMainlandStocksAdapter({ fetchImpl: async (url) => {
    if (!url.includes('fqkline')) return response(url)
    pages += 1
    const rows = url.includes('2026-09-28') ? [daily[0]] : daily.slice(1)
    return Response.json({ code: 0, data: { sh688836: { day: rows, qt } } })
  } })
  const market = await adapter.fetchTrend('UNITREE')
  assert.equal(pages, 2)
  assert.equal(market.points.length, 3)
  assert.equal(new Date(market.historyStart * 1000).toISOString().slice(0, 10), '2026-08-19')
})

test('minute outage is labeled as daily fallback; stale refresh preserves quote timestamp', async () => {
  let now = 1000
  let offline = false
  const adapter = createMainlandStocksAdapter({ now: () => now, fetchImpl: async (url) => {
    if (offline || url.includes('day/query')) throw new Error('offline')
    return response(url)
  } })
  const first = await adapter.fetchTrend('UNITREE', '1D')
  assert.equal(first.dataGranularity, '1d')
  assert.equal(first.points.length, 1)
  assert.equal(first.isStale, true)
  assert.match(first.dataNote, /分时源暂不可用/)
  offline = true
  now += 600_000
  const stale = await adapter.fetchTrend('UNITREE')
  assert.equal(stale.isStale, true)
  assert.equal(stale.marketTime, first.marketTime)
  assert.equal(stale.points.length, 3)
  await assert.rejects(createMainlandStocksAdapter({ fetchImpl: async () => { throw new Error('offline') } }).fetchTrend('UNITREE'))
})

test('mismatched Tencent issuer fails instead of charting another company', async () => {
  const adapter = createMainlandStocksAdapter({ fetchImpl: async (url) => {
    if (!url.includes('fqkline')) return response(url)
    return Response.json({ code: 0, data: { sh688836: { day: daily, qt: { sh688836: ['1', '另一家公司', '688836'] } } } })
  } })
  await assert.rejects(adapter.fetchTrend('UNITREE'), /身份/)
})
