import test from 'node:test'
import assert from 'node:assert/strict'
import { quoteSecid, makeConstituentValuation, createConstituentValuationService } from './constituent-valuations.mjs'

const apple = { key: 'US:AAPL', symbol: 'AAPL', name: 'Apple', market: 'US' }
const vanke = { key: 'CN:000002', symbol: '000002', name: '万科A', market: 'CN', secucode: '000002.SZ' }
const quote = { f12: 'AAPL', f13: 105, f20: 4913422580600, f115: 38.11, f23: 45.70, f130: 10.5252, f133: 0.32, f124: 1791403200 }
const now = () => Date.parse('2026-10-08T08:00:00Z')

test('resolves US listing from exact financial identity and keeps Chinese listing separate', () => {
  assert.equal(quoteSecid(apple, { SECURITY_CODE: 'AAPL', SECUCODE: 'AAPL.O' }), '105.AAPL')
  assert.equal(quoteSecid(apple, { SECURITY_CODE: 'AAPL', SECUCODE: 'MSFT.O' }), null)
  assert.equal(quoteSecid(apple), null)
  assert.equal(quoteSecid({ ...apple, symbol: '$AAPL$' }, { SECURITY_CODE: 'AAPL', SECUCODE: 'AAPL.O' }), null)
  assert.equal(quoteSecid(vanke), '0.000002')
  assert.equal(quoteSecid({ key: 'HK:00002', symbol: '00002.HK', market: 'HK' }), '116.00002')
  assert.equal(quoteSecid({ symbol: 'RR.', market: 'GB' }), '155.RR.')
  assert.equal(quoteSecid({ symbol: '005930', market: 'KR' }), '177.005930')
  assert.equal(quoteSecid({ symbol: 'SAP', market: 'DE' }), '185.SAP')
  assert.equal(quoteSecid({ symbol: 'DE0007164600', market: 'DE' }), null)
})

test('list quote fields retain percentages, loss ratios and original trading date', () => {
  const row = makeConstituentValuation(apple, quote, '105.AAPL', now())
  assert.equal(row.pe, 38.11)
  assert.equal(row.pb, 45.70)
  assert.equal(row.ps, 10.5252)
  assert.equal(row.dividendYield, 0.32)
  assert.equal(row.valuationDate, '2026-10-07')
  assert.equal(row.marketTime, quote.f124)
  assert.equal(row.reportDate, null)
  assert.equal(row.marketCap, 4913422580600)
  assert.equal(row.marketCapCurrency, 'USD')
  assert.equal(row.marketCapSortValue, row.marketCap)
  assert.throws(() => makeConstituentValuation(apple, { ...quote, f13: 106 }, '105.AAPL', now()))
  const loss = makeConstituentValuation(vanke, { ...quote, f12: '000002', f13: 0, f115: -0.53, f23: -0.2, f130: '-', f133: '-' }, '0.000002', now())
  assert.equal(loss.pe, -0.53)
  assert.equal(loss.pb, -0.2)
  assert.equal(loss.ps, null)
  assert.equal(loss.dividendYield, null)
})

test('market capitalization uses total cap, converts London pence and never compares B-share dollars directly to yuan', () => {
  const uk = makeConstituentValuation({ key: 'GB:HSBA', symbol: 'HSBA', market: 'GB' }, { ...quote, f13: 155, f12: 'HSBA', f20: 24135854745728, f21: 100 }, '155.HSBA', now())
  assert.equal(uk.marketCapCurrency, 'GBP')
  assert.equal(uk.marketCap, 241358547457.28)
  assert.equal(uk.marketCapSortValue, uk.marketCap)
  const company = { key: 'CN:900901', symbol: '900901', market: 'CN' }
  const bQuote = { ...quote, f13: 1, f12: '900901', f20: 828810114 }
  const missingFx = makeConstituentValuation(company, bQuote, '1.900901', now())
  assert.equal(missingFx.marketCap, 828810114)
  assert.equal(missingFx.marketCapCurrency, 'USD')
  assert.equal(missingFx.marketCapSortValue, null)
  const converted = makeConstituentValuation(company, bQuote, '1.900901', now(), { price: 6.7, marketTime: quote.f124 })
  assert.equal(converted.marketCapSortValue, 828810114 * 6.7)
  assert.match(converted.marketCapNote, /折算人民币/)
  const absentCap = makeConstituentValuation(apple, { ...quote, f20: '-' }, '105.AAPL', now())
  assert.equal(absentCap.marketCap, null)
  assert.equal(absentCap.marketCapSortValue, null)
})

test('missing quote sentinels are not zero dividends and future timestamps are not accepted', () => {
  const row = makeConstituentValuation(apple, { ...quote, f115: '-', f23: 0, f130: null, f133: '', f124: now() / 1000 + 600 }, '105.AAPL', now())
  assert.equal(row.pe, null)
  assert.equal(row.pb, null)
  assert.equal(row.ps, null)
  assert.equal(row.dividendYield, null)
  assert.equal(row.marketTime, null)
  assert.equal(makeConstituentValuation(apple, { ...quote, f133: [] }, '105.AAPL', now()).dividendYield, null)
})

test('batches membership queries, caches results and keeps all requested rows on missing quotes', async () => {
  const calls = []
  const service = createConstituentValuationService({ now, fetchImpl: async (url) => {
    calls.push(url)
    return { ok: true, json: async () => url.includes('reportName=')
      ? { success: true, result: { data: [{ SECURITY_CODE: 'AAPL', SECUCODE: 'AAPL.O' }] } }
      : { rc: 0, data: { diff: [quote] } } }
  } })
  const rows = (await service([apple, vanke])).rows
  assert.equal(rows.length, 2)
  assert.equal(rows[0].pe, 38.11)
  assert.equal(rows[1].pe, null)
  assert.equal(calls.length, 2)
  assert.equal(new URL(calls[1]).searchParams.get('secids'), '105.AAPL,0.000002')
  await service([apple, vanke])
  assert.equal(calls.length, 2)
  await assert.rejects(service(Array(21).fill(apple)), /20/)
})

test('overlapping requests share work and failure preserves last good values as stale', async () => {
  let clock = now()
  let offline = false
  let quotes = 0
  const service = createConstituentValuationService({ now: () => clock, ttl: 1000, fetchImpl: async (url) => {
    if (offline) throw new Error('offline')
    if (url.includes('reportName=')) return { ok: true, json: async () => ({ success: true, result: { data: [{ SECURITY_CODE: 'AAPL', SECUCODE: 'AAPL.O' }] } }) }
    quotes++
    return { ok: true, json: async () => ({ rc: 0, data: { diff: [quote] } }) }
  } })
  await Promise.all([service([apple]), service([apple])])
  assert.equal(quotes, 1)
  clock += 2000
  offline = true
  const row = (await service([apple])).rows[0]
  assert.equal(row.pe, 38.11)
  assert.equal(row.isStale, true)
})

test('quotes expire after one minute while verified US listing mappings use a separate long cache', async () => {
  let clock = now()
  let reports = 0
  let quotes = 0
  const service = createConstituentValuationService({ now: () => clock, fetchImpl: async (url) => {
    if (url.includes('reportName=')) {
      reports++
      return { ok: true, json: async () => ({ success: true, result: { data: [{ SECURITY_CODE: 'AAPL', SECUCODE: 'AAPL.O' }] } }) }
    }
    quotes++
    return { ok: true, json: async () => ({ rc: 0, data: { diff: [{ ...quote, f115: quotes }] } }) }
  } })
  await service([apple])
  clock += 59_000
  assert.equal((await service([apple])).rows[0].pe, 1)
  clock += 1000
  assert.equal((await service([apple])).rows[0].pe, 2)
  assert.equal(quotes, 2)
  assert.equal(reports, 1)
  clock += 24 * 3600_000
  await service([apple])
  assert.equal(reports, 2)
})

test('manual refresh bypasses a fresh quote cache and shares in-flight work without replacing quote time', async () => {
  let clock = now()
  let quotes = 0
  let reports = 0
  let unblock
  const wait = new Promise((resolve) => { unblock = resolve })
  const service = createConstituentValuationService({ now: () => clock, fetchImpl: async (url) => {
    if (url.includes('reportName=')) {
      reports++
      return { ok: true, json: async () => ({ success: true, result: { data: [{ SECURITY_CODE: 'AAPL', SECUCODE: 'AAPL.O' }] } }) }
    }
    const call = ++quotes
    if (call === 2) await wait
    return { ok: true, json: async () => ({ rc: 0, data: { diff: [{ ...quote, f115: call, f124: quote.f124 + call }] } }) }
  } })
  await service([apple])
  clock += 1000
  const forced = service([apple], { force: true })
  const duplicate = service([apple], { force: true })
  const normal = service([apple])
  clock += 2000
  unblock()
  const results = await Promise.all([forced, duplicate, normal])
  assert.equal(quotes, 2)
  assert.equal(reports, 1)
  for (const result of results) {
    assert.equal(result.asOf, clock / 1000)
    assert.equal(result.rows[0].pe, 2)
    assert.equal(result.rows[0].marketTime, quote.f124 + 2)
    assert.equal(result.rows[0].isStale, false)
  }
})

test('older or undated refreshes preserve the last verified quote, market capitalization and timestamp', async () => {
  let clock = now()
  let nextQuote = quote
  const service = createConstituentValuationService({ now: () => clock, fetchImpl: async (url) => ({ ok: true, json: async () => url.includes('reportName=')
    ? { success: true, result: { data: [{ SECURITY_CODE: 'AAPL', SECUCODE: 'AAPL.O' }] } }
    : { rc: 0, data: { diff: [nextQuote] } } }) })
  await service([apple])
  for (const timestamp of [quote.f124 - 60, '-', now() / 1000 + 3600]) {
    clock += 1000
    nextQuote = { ...quote, f115: 999, f20: 1, f124: timestamp }
    const result = await service([apple], { force: true })
    assert.equal(result.rows[0].pe, quote.f115)
    assert.equal(result.rows[0].marketCap, quote.f20)
    assert.equal(result.rows[0].marketTime, quote.f124)
    assert.equal(result.rows[0].isStale, true)
    assert.equal(result.asOf, clock / 1000)
  }
  nextQuote = { ...quote, f115: 40, f20: quote.f20 + 100, f124: quote.f124 + 60 }
  const recovered = (await service([apple], { force: true })).rows[0]
  assert.equal(recovered.pe, 40)
  assert.equal(recovered.marketCap, quote.f20 + 100)
  assert.equal(recovered.marketTime, quote.f124 + 60)
  assert.equal(recovered.isStale, false)
  assert.doesNotMatch(recovered.note, /保留/)
})

test('a partial refresh cannot erase a known market cap or relabel it with a newer quote timestamp', async () => {
  let nextQuote = quote
  const service = createConstituentValuationService({ now, fetchImpl: async (url) => ({ ok: true, json: async () => url.includes('reportName=')
    ? { success: true, result: { data: [{ SECURITY_CODE: 'AAPL', SECUCODE: 'AAPL.O' }] } }
    : { rc: 0, data: { diff: [nextQuote] } } }) })
  await service([apple])
  nextQuote = { ...quote, f20: '-', f115: 40, f124: quote.f124 + 60 }
  const row = (await service([apple], { force: true })).rows[0]
  assert.equal(row.marketCap, quote.f20)
  assert.equal(row.marketCapSortValue, quote.f20)
  assert.equal(row.marketTime, quote.f124)
  assert.equal(row.pe, quote.f115)
  assert.equal(row.isStale, true)
  assert.match(row.note, /总市值缺失/)
})
