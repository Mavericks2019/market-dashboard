import test from 'node:test'
import assert from 'node:assert/strict'
import { createCnyMarketClient, EUR_CNY_INSTRUMENT, fetchCnyTrend, parseCnyJsonp, parseCnyDayHistory, parseCnyMinuteHistory, parseCnyQuote, parseEurCnyQuote, selectCnyPoints } from './cny-market.mjs'

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

function quoteText(symbol, price, previousClose, timestamp = '2026-10-09 10:00:00') {
  const [date, time] = timestamp.split(' ')
  return `var hq_str_${symbol}="${time},${price},${price},${previousClose},410,${price},${price + 0.1},${price - 0.1},${price},FX,0,0,0,,0,0,,${date}";`
}

function jsonp(payload) {
  return `var _data=(${JSON.stringify(payload)});`
}

const eurHistory = '2008-09-04,9.9190,9.7354,9.9436,9.7463|2026-10-07,7.8,7.7,7.9,7.8|2026-10-08,7.9,7.8,8,7.9'
const usdHistory = '1994-08-30,8.5,8.5,8.5,8.5|2026-10-07,6.8,6.7,6.9,6.8|2026-10-08,6.7,6.6,6.8,6.7'

test('batched EUR/CNY and USD/CNY quotes never parse the other currency pair', () => {
  const batch = quoteText('fx_susdcny', 6.7, 6.8) + quoteText('fx_seurcny', 8.1, 7.9)
  const euro = parseEurCnyQuote(batch)
  assert.equal(euro.price, 8.1)
  assert.equal(euro.previousClose, 7.9)
  assert.equal(euro.dayHigh, 8.2)
  assert.equal(euro.marketTime, Date.parse('2026-10-09T10:00:00+08:00') / 1000)
  assert.ok(Math.abs(euro.changePercent - (8.1 / 7.9 - 1) * 100) < 1e-10)
  assert.equal(parseCnyQuote(batch).price, 6.7)
  assert.throws(() => parseEurCnyQuote(quoteText('fx_susdcny', 6.7, 6.8)))
  assert.throws(() => parseEurCnyQuote('var hq_str_fx_seurcny="";'))
  assert.equal(EUR_CNY_INSTRUMENT.unit, 'CNY/EUR')
})

test('pair clients isolate their quote/history requests, referers, caches, and stale fallback', async () => {
  let clock = Date.parse('2026-10-09T12:00:00+08:00')
  let failEuro = false
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push(url)
    const euro = url.includes('fx_seurcny')
    assert.ok(options.headers.Referer.endsWith(euro ? '/EURCNY.shtml' : '/USDCNY.shtml'))
    if (euro && failEuro) throw new Error('EUR source unavailable')
    return new Response(url.includes('hq.sinajs')
      ? quoteText(euro ? 'fx_seurcny' : 'fx_susdcny', euro ? 8.1 : 6.7, euro ? 7.9 : 6.8)
      : jsonp(euro ? eurHistory : usdHistory))
  }
  const euro = createCnyMarketClient({ currencyPair: 'EURCNY', fetchImpl, now: () => clock })
  const dollar = createCnyMarketClient({ fetchImpl, now: () => clock })
  const [eurFirst, usdFirst] = await Promise.all([euro.fetchTrend('MAX'), dollar.fetchTrend('MAX')])
  assert.equal(eurFirst.key, 'EURCNY')
  assert.equal(usdFirst.key, 'USDCNY')
  assert.equal(eurFirst.price, 8.1)
  assert.equal(usdFirst.price, 6.7)
  assert.equal(eurFirst.historyStart, Date.parse('2008-09-04T00:00:00+08:00') / 1000)
  assert.equal(usdFirst.historyStart, Date.parse('1994-08-30T00:00:00+08:00') / 1000)
  assert.equal(calls.length, 4)
  assert.deepEqual(await euro.fetchTrend('MAX'), eurFirst)
  assert.equal(calls.length, 4)
  failEuro = true
  clock += 10 * 60_000
  const [eurFallback, usdRefreshed] = await Promise.all([euro.fetchTrend('MAX'), dollar.fetchTrend('MAX')])
  assert.equal(eurFallback.isStale, true)
  assert.equal(usdRefreshed.isStale, false)
  assert.equal(eurFallback.price, 8.1)
  assert.equal(eurFallback.marketTime, eurFirst.marketTime)
  assert.deepEqual(eurFallback.points, eurFirst.points)
})

test('MAX fetches all available EUR/CNY daily history once and coalesces other daily ranges', async () => {
  const calls = []
  const client = createCnyMarketClient({ currencyPair: 'EURCNY', fetchImpl: async (url) => {
    calls.push(url)
    return new Response(url.includes('hq.sinajs') ? quoteText('fx_seurcny', 8.1, 7.9) : jsonp(eurHistory))
  } })
  const [all, year, month] = await Promise.all([client.fetchTrend('MAX'), client.fetchTrend('1Y'), client.fetchTrend('1M')])
  assert.equal(all.points.length, 3)
  assert.equal(year.points.length, 2)
  assert.equal(month.points.length, 2)
  assert.equal(calls.filter((url) => url.includes('getDayKLine')).length, 1)
  assert.equal(calls.filter((url) => url.includes('hq.sinajs')).length, 1)
  assert.ok(calls.every((url) => url.includes('fx_seurcny') && !url.includes('fx_susdcny')))
  assert.ok(calls.find((url) => url.includes('getDayKLine')).endsWith('symbol=fx_seurcny'))
})

test('intraday EUR/CNY chooses the latest observed source and ignores a future interval-end stamp for its quote', async () => {
  let clock = Date.parse('2026-10-09T12:00:00+08:00')
  let quoteTimestamp = '2026-10-09 10:00:00'
  const client = createCnyMarketClient({ currencyPair: 'EURCNY', now: () => clock, fetchImpl: async (url) => {
    if (url.includes('hq.sinajs')) return new Response(quoteText('fx_seurcny', 8.1, 7.9, quoteTimestamp))
    if (url.includes('getMinKline')) return new Response(jsonp([
      { d: '2026-10-09 11:00:00', o: '8.1', l: '8', h: '8.3', c: '8.2' },
      { d: '2026-10-09 12:05:00', o: '8.5', l: '8.4', h: '8.6', c: '8.5' },
    ]))
    return new Response(jsonp(eurHistory))
  } })
  const newerMinute = await client.fetchTrend('1D')
  assert.equal(newerMinute.price, 8.2)
  assert.equal(newerMinute.marketTime, Date.parse('2026-10-09T11:00:00+08:00') / 1000)
  assert.equal(newerMinute.previousClose, 7.9)
  assert.equal(newerMinute.dayHigh, 8.3)
  assert.equal(newerMinute.dataGranularity, '1m')
  assert.equal(newerMinute.points.at(-1).time, Date.parse('2026-10-09T12:05:00+08:00') / 1000)
  assert.match(newerMinute.dataNote, /区间结束时间/)
  clock += 60_000
  quoteTimestamp = '2026-10-09 12:00:00'
  const newerQuote = await client.fetchTrend('1D')
  assert.equal(newerQuote.price, 8.1)
  assert.equal(newerQuote.marketTime, Date.parse('2026-10-09T12:00:00+08:00') / 1000)
  const fiveDays = await client.fetchTrend('5D')
  assert.equal(fiveDays.dataGranularity, '5m')
  assert.equal(fiveDays.points.length, 2)
})

test('missing EUR/CNY quote falls back to real daily data, not a synthesized USD cross rate', async () => {
  const client = createCnyMarketClient({ currencyPair: 'EURCNY', fetchImpl: async (url) => {
    return new Response(url.includes('hq.sinajs') ? quoteText('fx_susdcny', 6.7, 6.8) : jsonp(eurHistory))
  } })
  const result = await client.fetchTrend('MAX')
  assert.equal(result.isStale, true)
  assert.equal(result.price, 7.9)
  assert.equal(result.previousClose, 7.8)
  assert.equal(result.marketTime, Date.parse('2026-10-08T00:00:00+08:00') / 1000)
  assert.match(result.dataNote, /刷新失败/)
})

test('cold unavailable EUR/CNY history and quote return an error and unsupported periods make no request', async () => {
  let requests = 0
  const client = createCnyMarketClient({ currencyPair: 'EURCNY', fetchImpl: async () => {
    requests += 1
    return new Response('unavailable', { status: 503 })
  } })
  await assert.rejects(client.fetchTrend('invalid'), /不支持/)
  assert.equal(requests, 0)
  await assert.rejects(client.fetchTrend('MAX'), /欧元兑人民币.*暂时不可用/)
  assert.equal(requests, 2)
  assert.throws(() => createCnyMarketClient({ currencyPair: 'UNKNOWN' }), /不支持/)
})
