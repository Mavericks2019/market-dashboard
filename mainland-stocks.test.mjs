import test from 'node:test'
import assert from 'node:assert/strict'
import { MAINLAND_STOCKS_INSTRUMENTS, MAINLAND_ETF_INSTRUMENTS, createMainlandStocksAdapter, parseMainlandDailyRows, parseMainlandMinuteSessions, parseMainlandStockQuote } from './mainland-stocks.mjs'

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

test('snapshot accepts source whitespace and fullwidth A while retaining issuer and symbol validation', () => {
  const instrument = MAINLAND_STOCKS_INSTRUMENTS.VANKE
  const fields = ['万 科Ａ', '3.80', '4.08', '4.26', '4.40', '3.67', '4.26', '4.27', '1309443983', ...Array(21).fill('0'), '2026-09-30', '16:29:15']
  const text = `var hq_str_sz000002="${fields.join(',')}";`
  assert.equal(parseMainlandStockQuote(text, instrument).price, 4.26)
  assert.equal(parseMainlandStockQuote(text.replace('万 科Ａ', '万  科A'), instrument).previousClose, 4.08)
  assert.throws(() => parseMainlandStockQuote(text.replace('万 科Ａ', '万科B'), instrument), /身份/)
  assert.throws(() => parseMainlandStockQuote(text.replace('sz000002', 'sz000001'), instrument), /身份/)
})

test('Tencent issuer normalization still rejects another share class or security code', async () => {
  const vankeRows = [['1991-01-29', '14.57', '14.58', '14.58', '14.57', '15'], ['2026-09-30', '3.80', '4.26', '4.40', '3.67', '13094440']]
  const makeAdapter = (name, code) => createMainlandStocksAdapter({ fetchImpl: async (url) => {
    if (url.includes('sinajs')) throw new Error('quote unavailable')
    return Response.json({ code: 0, data: { sz000002: { day: vankeRows, qt: { sz000002: ['51', name, code] } } } })
  } })
  const market = await makeAdapter('万  科Ａ', '000002').fetchTrend('VANKE')
  assert.equal(market.points.length, 2)
  assert.equal(market.price, 4.26)
  assert.match(market.dataNote, /万科深交所A股普通股/)
  await assert.rejects(makeAdapter('万科B', '000002').fetchTrend('VANKE'), /身份/)
  await assert.rejects(makeAdapter('万  科Ａ', '000001').fetchTrend('VANKE'), /身份/)
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

const etfQuoteFields = ['红利低波50ETF南方', '1.404', '1.410', '1.424', '1.425', '1.404', '1.423', '1.424', '114519698', ...Array(21).fill('0'), '2026-10-08', '11:30:00']
const etfQuoteText = `var hq_str_sh515450="${etfQuoteFields.join(',')}";`
const etfQuoteBytes = Buffer.concat([
  Buffer.from('var hq_str_sh515450="'), Buffer.from('baecc0fbb5cdb2a83530455446c4cfb7bd', 'hex'),
  Buffer.from(`,${etfQuoteFields.slice(1).join(',')}";`),
])

test('ETF snapshots accept the verified feed alias without confusing another fund, and preserve mill prices', () => {
  const instrument = MAINLAND_ETF_INSTRUMENTS.NF_DIV_LV50
  const snapshot = parseMainlandStockQuote(etfQuoteText, instrument)
  assert.equal(snapshot.price, 1.424)
  assert.equal(snapshot.previousClose, 1.410)
  assert.equal(new Date(snapshot.marketTime * 1000).toISOString(), '2026-10-08T03:30:00.000Z')
  assert.equal(parseMainlandStockQuote(etfQuoteText.replace('红利低波50ETF南方', instrument.name), instrument).price, 1.424)
  assert.throws(() => parseMainlandStockQuote(etfQuoteText.replace('红利低波50ETF南方', '红利低波100ETF南方'), instrument), /身份/)
  assert.throws(() => parseMainlandStockQuote(etfQuoteText.replace('sh515450', 'sh515180'), instrument), /身份/)
})

test('ETF MAX pages to exchange listing; intraday retains fund identity, three decimals and actual price basis', async () => {
  const requests = []
  const instrument = MAINLAND_ETF_INSTRUMENTS.NF_DIV_LV50
  const makeAdapter = (name = '红利低波50ETF南方', code = '515450') => createMainlandStocksAdapter({ fetchImpl: async (url) => {
    requests.push(url)
    if (url.includes('sinajs')) return new Response(etfQuoteBytes)
    const qt = { sh515450: ['1', name, code] }
    const data = url.includes('fqkline') ? {
      qt, day: url.includes('2022-08-16')
        ? [['2020-02-26', '1.037', '1.037', '1.052', '1.027', '568657']]
        : [['2022-08-17', '1.169', '1.174', '1.174', '1.163', '254907'], ['2026-10-08', '1.404', '1.424', '1.425', '1.404', '1145197']],
    } : { qt, data: [
      { date: '20261008', data: ['0930 1.404 7054', '1130 1.424 1145197'] },
      { date: '20260930', data: ['0930 1.395 1342', '1500 1.410 1417602'] },
    ] }
    return Response.json({ code: 0, data: { sh515450: data } })
  } })
  const adapter = makeAdapter()
  const [max, day, week] = await Promise.all(['MAX', '1D', '5D'].map((period) => adapter.fetchTrend(instrument.key, period)))
  assert.equal(requests.length, 4)
  assert.equal(max.points.length, 3)
  assert.equal(day.points.length, 2)
  assert.equal(week.points.length, 4)
  assert.equal(max.kind, 'etf')
  assert.equal(max.precision, 3)
  assert.equal(max.unit, 'CNY/份')
  assert.equal(max.watchStance, undefined)
  assert.equal(max.isStale, false)
  assert.equal(max.price, 1.424)
  assert.equal(max.points[0].close, 1.037)
  assert.equal(new Date(max.historyStart * 1000).toISOString().slice(0, 10), '2020-02-26')
  assert.equal(day.historyStart, max.historyStart)
  assert.equal(day.dataGranularity, '1m')
  assert.match(max.dataNote, /场内成交价格/)
  assert.match(max.dataNote, /基金净值及标的指数/)
  assert.match(max.dataNote, /不计入现金分红再投资/)
  await assert.rejects(makeAdapter('红利低波100ETF南方').fetchTrend(instrument.key), /身份/)
  await assert.rejects(makeAdapter('红利低波50ETF南方', '515180').fetchTrend(instrument.key), /身份/)
})
