import test from 'node:test'
import assert from 'node:assert/strict'
import { createHxcAdapter, parseHxcOfficialHistory, parseHxcEastmoneyQuote, parseHxcEastmoneyMinutes, parseHxcSinaQuote, parseHxcSinaHistory } from './hxc-market.mjs'

const official = [
  { x: Date.parse('2004-12-06T00:00:00Z'), y: 3438.42, Open: null, High: null, Low: null, FPSymbol: 'HXC' },
  { x: Date.parse('2026-10-06T00:00:00Z'), y: 5631.32, Open: 5600, High: 5655, Low: 5592, FPSymbol: 'HXC' },
  { x: Date.parse('2026-10-07T00:00:00Z'), y: 5638.07, Open: 5631.32, High: 5642.97, Low: 5577.47, FPSymbol: 'HXC' },
]
const emQuote = { data: { f57: 'HXC', f58: '纳斯达克中国金龙指数', f107: 251, f59: 2, f43: 563807, f60: 563132, f44: 564297, f45: 557747, f86: Date.parse('2026-10-07T20:00:00Z') / 1000 } }
const emMinutes = { data: { code: 'HXC', market: 251, name: '纳斯达克中国金龙指数', trends: [
  '2026-10-01 21:30,0.00,5718.05,5718.05,5718.05,0,0.00,5718.050',
  '2026-10-02 04:00,5720,5720,5720,5720,0,0.00,5720',
  '2026-10-02 21:30,5680,5680,5680,5680,0,0.00,5680',
  '2026-10-03 04:00,5690,5690,5690,5690,0,0.00,5690',
  '2026-10-05 21:30,5550,5550,5550,5550,0,0.00,5550',
  '2026-10-06 04:00,5613,5613,5613,5613,0,0.00,5613',
  '2026-10-06 21:30,5630,5630,5630,5630,0,0.00,5630',
  '2026-10-07 04:00,5631.32,5631.32,5631.32,5631.32,0,0.00,5631.32',
  '2026-10-07 21:30,5608.06,5608.06,5608.06,5608.06,0,0.00,5608.06',
  '2026-10-08 04:00,5635.62,5638.07,5638.53,5634.96,0,0.00,5620.526',
] } }
const quoteFields = ['纳斯达克中国金龙指数', '5638.0698', '0.12', '2026-10-08 05:16:29', '6.7500', '5608.0601', '5642.9702', '5577.4702', ...Array(18).fill('0'), '5631.3198']
const sinaQuote = `var hq_str_gb_$hxc="${quoteFields.join(',')}";`
const jsonp = (rows) => `/*<script>location.href='//sina.com';</script>*/\nvar _data=(${JSON.stringify(rows)});`
const sinaDays = [{ d: '2019-05-21', o: '8750.22', h: '8926.09', l: '8747.39', c: '8872.27', v: '0' }, { d: '2026-10-07', o: '5608.06', h: '5642.97', l: '5577.47', c: '5638.07', v: '0' }]
const sinaMinutes = [{ d: '2026-10-06 16:00:00', o: '5629', h: '5632', l: '5628', c: '5631', v: '0' }, { d: '2026-10-07 16:00:00', o: '5639.5269', h: '5639.5269', l: '5634.9775', c: '5636.2764', v: '0' }]
function fixtureFetch(url) {
  if (url.includes('HistoryChartData')) return Response.json(official)
  if (url.includes('/stock/get?')) return Response.json(emQuote)
  if (url.includes('trends2')) return Response.json(emMinutes)
  if (url.includes('getDailyK')) return new Response(jsonp(sinaDays))
  if (url.includes('getMinK')) return new Response(jsonp(sinaMinutes))
  throw new Error('unavailable')
}

test('official HXC history verifies price-index identity and keeps New York dates without inventing early values', () => {
  const points = parseHxcOfficialHistory(official)
  assert.equal(points.length, 3)
  assert.equal(new Date(points[0].time * 1000).toISOString(), '2004-12-06T12:00:00.000Z')
  assert.equal(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(points[0].time * 1000)), '2004-12-06')
  assert.equal(points.at(-1).close, 5638.07)
  assert.equal(points.at(-1).open, null)
  assert.equal(points.at(-1).volume, null)
  assert.throws(() => parseHxcOfficialHistory([{ ...official[0], FPSymbol: 'HXCX' }]), /身份/)
  assert.throws(() => parseHxcOfficialHistory([{ ...official[0], y: 0 }]), /点位/)
  assert.throws(() => parseHxcOfficialHistory([...official, official[0]]), /重复/)
})

test('quote sources validate the index and do not confuse ordinary HXC stock or Beijing timestamps', () => {
  const em = parseHxcEastmoneyQuote(emQuote)
  assert.equal(em.price, 5638.07)
  assert.equal(em.previousClose, 5631.32)
  assert.equal(em.marketTime, emQuote.data.f86)
  assert.throws(() => parseHxcEastmoneyQuote({ data: { ...emQuote.data, f107: 105 } }), /身份/)
  assert.throws(() => parseHxcEastmoneyQuote({ data: { ...emQuote.data, f58: 'HXC' } }), /身份/)
  const sina = parseHxcSinaQuote(sinaQuote)
  assert.equal(sina.price, 5638.0698)
  assert.equal(new Date(sina.marketTime * 1000).toISOString(), '2026-10-07T21:16:29.000Z')
  assert.throws(() => parseHxcSinaQuote(sinaQuote.replace('gb_$hxc', 'gb_hxc')), /身份/)
  assert.throws(() => parseHxcSinaQuote(sinaQuote.replace('纳斯达克中国金龙指数', 'HXC')), /身份/)
})

test('Eastmoney minutes use Beijing time and index-only data, with no synthetic volume', () => {
  const points = parseHxcEastmoneyMinutes(emMinutes)
  assert.equal(points.length, 10)
  assert.equal(new Date(points[0].time * 1000).toISOString(), '2026-10-01T13:30:00.000Z')
  assert.equal(new Date(points.at(-1).time * 1000).toISOString(), '2026-10-07T20:00:00.000Z')
  assert.equal(points[0].open, null)
  assert.equal(points.at(-1).volume, null)
  assert.throws(() => parseHxcEastmoneyMinutes({ data: { ...emMinutes.data, code: 'HXCX' } }), /身份/)
  assert.throws(() => parseHxcEastmoneyMinutes({ data: { ...emMinutes.data, trends: [...emMinutes.data.trends, emMinutes.data.trends[0]] } }), /重复/)
})

test('Sina fallback minute timestamps honor EST and EDT instead of a fixed UTC offset', () => {
  const rows = ['2026-01-06 09:35:00', '2026-07-06 09:35:00'].map((d) => ({ d, c: 5600, o: 5600, h: 5600, l: 5600, v: 0 }))
  const points = parseHxcSinaHistory(jsonp(rows), true)
  assert.equal(new Date(points[0].time * 1000).toISOString(), '2026-01-06T14:35:00.000Z')
  assert.equal(new Date(points[1].time * 1000).toISOString(), '2026-07-06T13:35:00.000Z')
  assert.throws(() => parseHxcSinaHistory('var _data=(globalThis.run());'), /JSON/)
})

test('MAX uses official full history and minute periods select US sessions across Beijing midnight', async () => {
  const calls = []
  const adapter = createHxcAdapter({ fetchImpl: async (url, options) => { calls.push({ url, options }); return fixtureFetch(url) } })
  const [max, day, week] = await Promise.all(['MAX', '1D', '5D'].map((period) => adapter.fetchTrend(period)))
  assert.equal(calls.length, 3)
  assert.equal(calls.find((call) => call.url.includes('HistoryChartData')).options.body.get('id'), 'HXC')
  assert.equal(max.points.length, 3)
  assert.equal(day.points.length, 2)
  assert.equal(week.points.length, 10)
  assert.equal(max.historyStart, day.historyStart)
  assert.equal(day.dataGranularity, '1m')
  assert.equal(max.price, 5638.07)
  assert.equal(day.previousClose, 5631.32)
  assert.equal(max.isStale, false)
  assert.match(max.dataNote, /2004-12-06/)
  assert.match(max.dataNote, /未覆盖基期/)
})

test('failed official history retains the existing complete cache and raw dates instead of replacing it with shorter data', async () => {
  let time = Date.now()
  let failOfficial = false
  const adapter = createHxcAdapter({ now: () => time, fetchImpl: async (url) => {
    if (failOfficial && url.includes('HistoryChartData')) throw new Error('offline')
    return fixtureFetch(url)
  } })
  const first = await adapter.fetchTrend('MAX')
  time += 301_000
  failOfficial = true
  const cached = await adapter.fetchTrend('MAX')
  assert.equal(cached.isStale, true)
  assert.equal(cached.historyStart, first.historyStart)
  assert.deepEqual(cached.points, first.points)
  assert.match(cached.dataNote, /刷新失败/)
})

test('cold-start fallback discloses shorter daily history and actual five-minute granularity', async () => {
  const adapter = createHxcAdapter({ fetchImpl: async (url) => {
    if (url.includes('HistoryChartData') || url.includes('trends2')) throw new Error('primary offline')
    return fixtureFetch(url)
  } })
  const [max, day] = await Promise.all([adapter.fetchTrend('MAX'), adapter.fetchTrend('1D')])
  assert.match(max.dataNote, /2019-05-21/)
  assert.match(max.sourceName, /备用日线/)
  assert.equal(day.dataGranularity, '5m')
  assert.equal(day.points.length, 1)
  assert.equal(day.points[0].close, 5636.2764)
  assert.equal(day.price, 5638.07)
})

test('complete minute-source failure returns real daily data with an explicit fallback and stale indicator', async () => {
  const adapter = createHxcAdapter({ fetchImpl: async (url) => {
    if (url.includes('trends2') || url.includes('getMinK')) throw new Error('minutes offline')
    return fixtureFetch(url)
  } })
  const day = await adapter.fetchTrend('1D')
  assert.equal(day.points.length, 1)
  assert.equal(day.dataGranularity, '1d')
  assert.equal(day.isStale, true)
  assert.match(day.dataNote, /分时源暂不可用/)
  await assert.rejects(adapter.fetchTrend('BAD'), /未知周期/)
})
