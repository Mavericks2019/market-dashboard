import test from 'node:test'
import assert from 'node:assert/strict'
import { createHstechClient, parseHstechDaily, parseHstechMinutes, parseHstechQuote, selectHstechPoints } from './hstech-market.mjs'

const dailyPayload = { rc: 0, data: { code: 'HSTECH', klines: [
  '2014-12-31,3000,3000,3000,3000,0',
  '2026-10-05,4190,4183.68,4200,4180,123',
  '2026-10-06,4226.38,4210,4251.54,4205.73,456',
] } }
const quoteText = 'var hq_str_rt_hkHSTECH="HSTECH,Hang Seng TECH Index,4226.380,4183.680,4251.540,4205.730,4210.000,26.320,0.629,0,0,0,0,0,0,6605,4111,2026/10/06,10:00:00";'

test('daily history validates index identity and OHLC, sorts, deduplicates and keeps backtests as closing levels', () => {
  const points = parseHstechDaily({ rc: 0, data: { code: 'HSTECH', klines: [
    '2020-07-27,6918,6774,7014,6677,0',
    '2014-12-31,3000,3000,3000,3000,0',
    '2020-07-27,6918,6774.78,7014,6677,0',
    '2020-07-28,1,0,2,1,0',
    '2020-07-29,1,3,2,1,0',
    '2020-02-30,1,2,3,1,0',
  ] } })
  assert.equal(points.length, 2)
  assert.equal(points[0].close, 3000)
  assert.equal(new Date(points[0].time * 1000).toISOString().slice(0, 10), '2014-12-31')
  assert.equal(new Date((points[0].time + 8 * 3600) * 1000).toISOString().slice(0, 10), '2014-12-31')
  assert.equal(points[0].open, null)
  assert.equal(points[1].close, 6774.78)
  assert.throws(() => parseHstechDaily({ rc: 0, data: { code: 'HSI', klines: dailyPayload.data.klines } }))
  assert.throws(() => parseHstechDaily({ rc: 0, data: { code: 'HSTECH', klines: [] } }))
})

test('quote uses real HSTECH and an explicit Hong Kong timestamp', () => {
  const quote = parseHstechQuote(quoteText)
  assert.equal(quote.price, 4210)
  assert.equal(quote.previousClose, 4183.68)
  assert.equal(quote.dayHigh, 4251.54)
  assert.equal(quote.marketTime, Date.parse('2026-10-06T10:00:00+08:00') / 1000)
  assert.throws(() => parseHstechQuote('var hq_str_rt_hkHSTECH="";'))
  assert.throws(() => parseHstechQuote(quoteText.replace('2026/10/06', '2026/02/30')))
})

test('minute rows remain actual observations, and 1D/5D select Hong Kong trading sessions', () => {
  const sessions = ['20260928', '20260929', '20260930', '20261002', '20261005', '20261006'].reverse().map((date) => ({
    date, data: ['0930 4100 100', '0931 4101 101', '0931 4102 102', '2500 4100 103', '0932 0 104'],
  }))
  const points = parseHstechMinutes({ code: 0, data: { hkHSTECH: { data: sessions } } })
  assert.equal(points.length, 12)
  assert.equal(points[1].close, 4102)
  assert.equal(points[1].open, null)
  assert.equal(selectHstechPoints(points, '1D').length, 2)
  assert.equal(selectHstechPoints(points, '5D').length, 10)
  assert.throws(() => selectHstechPoints(points, 'unknown'))
})

test('failed refresh preserves observed timestamps and all-history coverage, while a cold failure rejects', async () => {
  let currentTime = 0
  let available = true
  const fetchImpl = async (url) => {
    if (!available) throw new Error('offline')
    if (url.includes('sinajs')) return new Response(quoteText)
    if (url.includes('push2his')) return Response.json(dailyPayload)
    return Response.json({ code: 0, data: { hkHSTECH: { data: [{ date: '20261006', data: ['0930 4226.38', '1000 4210'] }] } } })
  }
  const client = createHstechClient({ fetchImpl, now: () => currentTime })
  const all = await client('MAX')
  const intraday = await client('1D')
  const fiveDays = await client('5D')
  assert.equal(all.points.length, 3)
  assert.equal(all.isStale, false)
  assert.equal(intraday.historyStart, all.historyStart)
  assert.equal(fiveDays.historyStart, all.historyStart)
  assert.equal(intraday.dataGranularity, '1m')
  available = false
  currentTime = 600000
  const stale = await client('MAX')
  assert.equal(stale.isStale, true)
  assert.equal(stale.marketTime, all.marketTime)
  assert.deepEqual(stale.points, all.points)
  const cold = createHstechClient({ fetchImpl })
  await assert.rejects(cold('MAX'), /暂不可用/)
})

test('minute failure falls back to daily bars without labelling daily observations as minutes', async () => {
  const client = createHstechClient({ fetchImpl: async (url) => {
    if (url.includes('sinajs')) return new Response(quoteText)
    if (url.includes('push2his')) return Response.json(dailyPayload)
    throw new Error('minute feed unavailable')
  } })
  const result = await client('1D')
  assert.equal(result.dataGranularity, '1d')
  assert.equal(result.isStale, true)
  assert.equal(result.points.length, 1)
  assert.match(result.dataNote, /分时暂不可用/)
})

test('primary history outage retains earlier backtest history when using Tencent recent data', async () => {
  let currentTime = 0
  const client = createHstechClient({ now: () => currentTime, fetchImpl: async (url) => {
    if (url.includes('sinajs')) return new Response(quoteText)
    if (url.includes('push2his')) {
      if (currentTime) throw new Error('primary down')
      return Response.json(dailyPayload)
    }
    return Response.json({ code: 0, data: { hkHSTECH: { day: [['2026-10-06', '4226.38', '4211', '4251.54', '4205.73']] } } })
  } })
  const initial = await client('MAX')
  currentTime = 600000
  const fallback = await client('MAX')
  const cachedFallback = await client('MAX')
  assert.equal(fallback.historyStart, initial.historyStart)
  assert.equal(fallback.points.at(-1).close, 4211)
  assert.equal(fallback.isStale, true)
  assert.equal(cachedFallback.isStale, true)
})
