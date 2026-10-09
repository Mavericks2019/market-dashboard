import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFixedInvestmentClient, makeAnnualFixedInvestmentSnapshot, makeFixedInvestmentSnapshot, normalizeAnnualFixedInvestmentRecords, normalizeFixedInvestmentRows, parseOfficialFixedInvestment } from './fixed-investment.mjs'

const NOW = Date.parse('2026-10-09T14:00:00+08:00')
const row = (month, amount = 50000, extra = {}) => ({ REPORT_DATE: `${month}-01 00:00:00`, BASE_ACCUMULATE: amount, ...extra })
const publicationUrl = 'https://www.stats.gov.cn/sj/zxfbhjd/202609/t20260915_1965309.html'
const official = { month: '2026-08', amount: 293092, yoy: -7.2, releaseDate: '2026-09-15', sourceUrl: publicationUrl }
const history = Array.from({ length: 7 }, (_, index) => row(`2026-${String(index + 2).padStart(2, '0')}`, index === 6 ? 293092 : 10000 * (index + 1)))
const options = { now: () => NOW, cacheFile: null, snapshotFile: null, annualSnapshotFile: null, expectedStart: '2026-02', officialEnabled: false }
const payload = (data, pages = 1, count = data.length) => new Response(JSON.stringify({ success: true, result: { data, pages, count } }))
const officialHtml = `<title>2026年1—8月份全国固定资产投资基本情况 - 国家统计局</title><div>2026/09/15 10:00</div><p>1—8月份，全国固定资产投资（不含农户）293092亿元，同比下降7.2%（按可比口径计算）。</p>`
const annual2025 = { year: 2025, amount: 485186, yoy: -3.8, releaseDate: '2026-01-19', sourceUrl: 'https://www.stats.gov.cn/sj/zxfb/202601/t20260119_1962326.html' }

test('bundled annual history covers every complete 2012–2025 year and preserves positive official growth across amount revisions', async () => {
  const snapshot = JSON.parse(await readFile(new URL('./data/annual-fixed-investment-history.json', import.meta.url), 'utf8'))
  const records = normalizeAnnualFixedInvestmentRecords(snapshot.records, NOW)
  assert.deepEqual(records.map((record) => record.year), Array.from({ length: 14 }, (_, index) => 2012 + index))
  assert.equal(records.find((record) => record.year === 2019).amount < records.find((record) => record.year === 2018).amount, true)
  assert.equal(records.find((record) => record.year === 2019).yoy, 5.4)
  assert.equal(records.filter((record) => record.yoy > 0).length, 13)
  assert.deepEqual(records.filter((record) => record.yoy < 0).map((record) => record.year), [2025])
  assert.deepEqual(records.at(-1), annual2025)
})

test('annual history contains only completed years with sourced published YoY, not growth inferred from amounts', () => {
  const early = { ...annual2025, year: 2012, amount: 364835, yoy: 20.6, releaseDate: '2013-01-18' }
  const records = normalizeAnnualFixedInvestmentRecords([
    annual2025, early, { ...annual2025, amount: 485186 },
    { ...annual2025, year: 2026, amount: 293092, yoy: -7.2, releaseDate: '2026-09-15' },
    { ...annual2025, year: 2024, amount: 500000, yoy: null },
    { ...annual2025, year: 2023, sourceUrl: 'https://example.com/article.html' },
    { ...annual2025, year: 2022, releaseDate: '2022-12-31' },
    { ...annual2025, year: 2021, releaseDate: '2026-02-30' },
  ], NOW)
  assert.deepEqual(records.map((record) => record.year), [2012, 2024, 2025])
  assert.equal(records[0].yoy, 20.6)
  assert.equal(records[1].yoy, null)
  assert.equal(records[2].yoy, -3.8)
  assert.notEqual(records[2].yoy, (485186 / 500000 - 1) * 100)
})

test('offline force refresh preserves independently loaded annual official history without extra network calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'annual-fixed-investment-'))
  try {
    const annualSnapshotFile = join(directory, 'annual.json')
    await writeFile(annualSnapshotFile, JSON.stringify(makeAnnualFixedInvestmentSnapshot([annual2025], NOW - 1000)))
    let calls = 0
    let offline = false
    const client = createFixedInvestmentClient({ ...options, annualSnapshotFile, fetchImpl: async () => {
      calls++
      if (offline) throw new Error('offline')
      return payload(history)
    } })
    const original = await client()
    assert.deepEqual(original.annualRecords, [annual2025])
    assert.equal(calls, 1)
    await client()
    assert.equal(calls, 1)
    offline = true
    const fallback = await client({ force: true })
    assert.equal(fallback.isStale, true)
    assert.deepEqual(fallback.annualRecords, original.annualRecords)
    assert.deepEqual(fallback.records, original.records)
    assert.equal(calls, 2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('new full-year official release merges annually and survives cache reload despite different revised monthly amounts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'annual-investment-merge-'))
  const nextNow = Date.parse('2027-01-20T12:00:00+08:00')
  const annualPublication = 'https://www.stats.gov.cn/sj/zxfbhjd/202701/t20270119_1970000.html'
  const annual2026 = { year: 2026, amount: 500000, yoy: 1.2, releaseDate: '2027-01-19', sourceUrl: annualPublication }
  const fullYear = Array.from({ length: 11 }, (_, index) => row(`2026-${String(index + 2).padStart(2, '0')}`, index === 10 ? 400000 : 20000 * (index + 1)))
  const html = '<title>2026年全国固定资产投资基本情况 - 国家统计局</title><div>2027/01/19 10:00</div><p>全国固定资产投资（不含农户）500000亿元，比上年增长1.2%。</p>'
  try {
    const annualSnapshotFile = join(directory, 'annual.json')
    const cacheFile = join(directory, 'monthly-cache.json')
    await writeFile(annualSnapshotFile, JSON.stringify(makeAnnualFixedInvestmentSnapshot([annual2025], NOW - 1000)))
    let calls = 0
    const client = createFixedInvestmentClient({ ...options, now: () => nextNow, annualSnapshotFile, cacheFile, officialEnabled: true, fetchImpl: async (address) => {
      calls++
      if (address === 'https://www.stats.gov.cn/sj/zxfbhjd/') return new Response(`<a href="./202701/t20270119_1970000.html" title="2026年全国固定资产投资基本情况">年度发布</a>`)
      if (address === annualPublication) return new Response(html)
      return payload(fullYear)
    } })
    const data = await client()
    assert.equal(data.isStale, false)
    assert.deepEqual(data.annualRecords, [annual2025, annual2026])
    assert.equal(data.records.at(-1).amount, 400000)
    assert.equal(data.records.at(-1).yoy, null)
    assert.equal(data.annualRecords.at(-1).amount, 500000)
    assert.equal(calls, 3)
    const refreshed = await client({ force: true })
    assert.deepEqual(refreshed.annualRecords, data.annualRecords)
    const offline = createFixedInvestmentClient({ ...options, now: () => nextNow, cacheFile, fetchImpl: async () => { throw new Error('offline') } })
    const reloaded = await offline({ force: true })
    assert.equal(reloaded.isStale, true)
    assert.deepEqual(reloaded.annualRecords, data.annualRecords)
    assert.deepEqual(reloaded.records, data.records)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('amounts are YTD observations; single-month growth is never presented as official cumulative YoY', () => {
  const records = normalizeFixedInvestmentRows([
    row('2026-08', 293092, { BASE: 32764, BASE_SAME: -13.51, BASE_SEQUENTIAL: -3.52 }),
    row('2026-02', '30000'), row('2026-02', '40000'), row('2026-01', 20000), row('2026-10', 300000),
    row('2026-13', 10), row('2026-07', null), row('2026-06', false), row('2026-05', -4),
    row('2011-12', 20000), row('2026-03', [], { REPORT_DATE: '2026-03-31' }),
  ], [], NOW)
  assert.deepEqual(records, [{ month: '2026-02', amount: 40000, yoy: null }, { month: '2026-08', amount: 293092, yoy: null }])
})

test('only identifiable official releases supply comparable YoY; mismatched amounts fail', () => {
  const records = normalizeFixedInvestmentRows(history, [official, { ...official, month: '2026-07', sourceUrl: 'https://other.example/release.html' }], NOW)
  assert.deepEqual(records.at(-1), official)
  assert.equal(records.at(-2).yoy, null)
  assert.throws(() => normalizeFixedInvestmentRows(history, [{ ...official, amount: 300000 }], NOW), /官方公报不一致/)
  assert.equal(normalizeFixedInvestmentRows(history, [{ ...official, releaseDate: '2026-11-15' }], NOW).at(-1).yoy, null)
})

test('official release parser extracts the calendar period, published amount, direction and release date', () => {
  assert.deepEqual(parseOfficialFixedInvestment(officialHtml, publicationUrl), official)
  const growth = officialHtml.replace('下降7.2%', '增长3.4%')
  assert.equal(parseOfficialFixedInvestment(growth, publicationUrl).yoy, 3.4)
  const annual = officialHtml.replace('2026年1—8月份', '2025年').replace('同比下降7.2%', '比上年下降3.8%')
  assert.equal(parseOfficialFixedInvestment(annual, publicationUrl).month, '2025-12')
  assert.equal(parseOfficialFixedInvestment(annual, publicationUrl).yoy, -3.8)
  assert.throws(() => parseOfficialFixedInvestment('<p>金额同比-13.51%</p>', publicationUrl), /字段不匹配/)
})

test('concurrent complete pagination is coalesced and force bypasses warm TTL', async () => {
  const calls = []
  const client = createFixedInvestmentClient({ ...options, fetchImpl: async (address) => {
    const url = new URL(address)
    assert.equal(url.searchParams.get('reportName'), 'RPT_ECONOMY_ASSET_INVEST')
    assert.equal(url.searchParams.get('columns'), 'REPORT_DATE,BASE_ACCUMULATE')
    const page = Number(url.searchParams.get('pageNumber'))
    calls.push(page)
    await new Promise((resolve) => setImmediate(resolve))
    return payload(page === 1 ? history.slice(3) : history.slice(0, 3), 2, history.length)
  } })
  const results = await Promise.all([client(), client(), client({ force: true })])
  assert.deepEqual(calls, [1, 2])
  assert.equal(results[0].historyStart, '2026-02')
  assert.equal(results[0].latestMonth, '2026-08')
  assert.deepEqual(results[0].records, results[1].records)
  await client()
  assert.deepEqual(calls, [1, 2])
  await Promise.all([client({ force: true }), client({ force: true })])
  assert.deepEqual(calls, [1, 2, 1, 2])
})

test('official latest publication can supplement missing upstream latest month with sourced values', async () => {
  const client = createFixedInvestmentClient({ ...options, officialEnabled: true, fetchImpl: async (address) => {
    if (address === 'https://www.stats.gov.cn/sj/zxfbhjd/') return new Response(`<a href="./202609/t20260915_1965309.html" title="2026年1—8月份全国固定资产投资基本情况">公报</a>`)
    if (address === publicationUrl) return new Response(officialHtml)
    return payload(history.slice(0, 6))
  } })
  const data = await client()
  assert.equal(data.records.length, 7)
  assert.deepEqual(data.records.at(-1), official)
  assert.equal(data.releaseDate, '2026-09-15')
  assert.equal(data.sourceUrl, publicationUrl)
  assert.equal(data.releaseSourceUrl, publicationUrl)
})

test('complete source amounts remain usable when the official publication service is unavailable', async () => {
  const client = createFixedInvestmentClient({ ...options, officialEnabled: true, fetchImpl: async (address) => {
    if (address.includes('stats.gov.cn')) throw new Error('official service offline')
    return payload(history)
  } })
  const data = await client()
  assert.equal(data.isStale, false)
  assert.equal(data.records.at(-1).yoy, null)
  assert.equal(data.releaseDate, undefined)
})

test('partial, duplicate, or missing-month source histories cannot overwrite saved coverage', async () => {
  for (const damaged of [
    () => payload(history.slice(1)),
    () => payload(history.filter((record) => !record.REPORT_DATE.startsWith('2026-05'))),
    () => payload([...history.slice(1), history[1]]),
    () => payload(history.slice(0, 6), 1, 7),
    () => payload(history.map((record, index) => index === 2 ? { ...record, BASE_ACCUMULATE: null } : record)),
  ]) {
    let bad = false
    const client = createFixedInvestmentClient({ ...options, fetchImpl: async () => bad ? damaged() : payload(history) })
    const original = await client()
    bad = true
    const fallback = await client({ force: true })
    assert.equal(fallback.isStale, true)
    assert.deepEqual(fallback.records, original.records)
    assert.equal(fallback.asOf, original.asOf)
  }
})

test('cold saved history is returned immediately while stalled network refresh runs in the background', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fixed-investment-'))
  let resolveNetwork
  try {
    const snapshotFile = join(directory, 'snapshot.json')
    await writeFile(snapshotFile, JSON.stringify(makeFixedInvestmentSnapshot(normalizeFixedInvestmentRows(history, [official], NOW), NOW - 24 * 60 * 60_000)))
    const client = createFixedInvestmentClient({ ...options, snapshotFile, fetchImpl: async () => new Promise((resolve) => { resolveNetwork = () => resolve(payload(history)) }) })
    const data = await client()
    assert.equal(data.isStale, true)
    assert.equal(data.asOf, (NOW - 24 * 60 * 60_000) / 1000)
    assert.deepEqual(data.records.at(-1), official)
    assert.equal(typeof resolveNetwork, 'function')
    const joined = client({ force: true })
    resolveNetwork()
    assert.equal((await joined).isStale, false)
  } finally {
    resolveNetwork?.()
    await rm(directory, { recursive: true, force: true })
  }
})

test('failure backoff retains real records and force still bypasses it', async () => {
  let time = NOW
  let calls = 0
  const client = createFixedInvestmentClient({ ...options, now: () => time, fetchImpl: async () => {
    if (++calls > 1) throw new Error('offline')
    return payload(history)
  } })
  const original = await client()
  time += 7 * 60 * 60_000
  const fallback = await client({ force: true })
  assert.equal(fallback.isStale, true)
  assert.deepEqual(fallback.records, original.records)
  await client()
  assert.equal(calls, 2)
  await client({ force: true })
  assert.equal(calls, 3)
})

test('cold source failures and timeouts fail explicitly without manufacturing an observation', async () => {
  const offline = createFixedInvestmentClient({ ...options, fetchImpl: async () => { throw new Error('offline') } })
  await assert.rejects(offline(), /暂不可用/)
  const invalid = createFixedInvestmentClient({ ...options, fetchImpl: async () => new Response(JSON.stringify({ success: false, result: { data: history, pages: 1, count: 7 } })) })
  await assert.rejects(invalid(), /分页格式异常/)
  const timeout = createFixedInvestmentClient({ ...options, timeoutMs: 5, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))) })
  await assert.rejects(timeout(), /请求超时/)
})
