import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildHousingLevelHistory, createHousingClient, makeHousingSnapshot, normalizeHousingRows } from './housing-market.mjs'

const NOW = Date.parse('2026-10-06T10:00:00+08:00')
const row = (city, month, extra = {}) => ({
  CITY: city,
  REPORT_DATE: `${month}-01 00:00:00`,
  FIRST_COMHOUSE_SEQUENTIAL: 99.8,
  FIRST_COMHOUSE_SAME: 97.7,
  SECOND_HOUSE_SEQUENTIAL: 99.9,
  SECOND_HOUSE_SAME: 96.5,
  ...extra,
})
const payload = (data, pages = 1, count = data.length) => new Response(JSON.stringify({ success: true, result: { data, pages, count } }), { headers: { 'content-type': 'application/json' } })
const options = { now: () => NOW, snapshotFile: null, cacheFile: null, expectedCities: 2 }
const observations = [row('北京', '2011-01'), row('上海', '2011-01'), row('北京', '2026-08'), row('上海', '2026-08')]

const levelRecord = (month, newMom, resaleMom, newYoy = 150, resaleYoy = 150) => ({
  month, newHome: { momIndex: newMom, yoyIndex: newYoy }, resale: { momIndex: resaleMom, yoyIndex: resaleYoy },
})

test('price level compounds subsequent monthly changes without rounding or applying the reference month change', () => {
  const original = [
    levelRecord('2011-01', 130, 160),
    levelRecord('2011-02', 110, 103.7),
    levelRecord('2011-03', 90, 102.3),
    levelRecord('2011-04', 106, 101.9),
  ]
  const copy = structuredClone(original)
  const levels = buildHousingLevelHistory(original)
  assert.deepEqual(levels.map((record) => record.newHome.levelIndex), [100, 110, 99, 104.94])
  assert.equal(levels[2].resale.levelIndex, (100 * 103.7 / 100) * 102.3 / 100)
  assert.equal(levels[3].resale.levelIndex, ((100 * 103.7 / 100) * 102.3 / 100) * 101.9 / 100)
  assert.deepEqual(original, copy)
  assert.equal(levels[3].newHome.momIndex, 106)
  assert.equal(levels[3].newHome.yoyIndex, 150)
})

test('missing months stop both chains; missing ratios stop only their property and never recover via YoY', () => {
  const invalidRatio = buildHousingLevelHistory([
    levelRecord('2011-01', 105, 105),
    levelRecord('2011-02', null, 110),
    levelRecord('2011-03', 110, 90, 150, 150),
  ])
  assert.deepEqual(invalidRatio.map((record) => record.newHome.levelIndex), [100, null, null])
  assert.deepEqual(invalidRatio.map((record) => record.resale.levelIndex), [100, 110, 99])
  const missingMonth = buildHousingLevelHistory([
    levelRecord('2011-01', 100, 100), levelRecord('2011-02', 110, 110),
    levelRecord('2011-04', 90, 90), levelRecord('2011-05', 120, 120),
  ])
  assert.deepEqual(missingMonth.map((record) => record.newHome.levelIndex), [100, 110, null, null])
  assert.deepEqual(missingMonth.map((record) => record.resale.levelIndex), [100, 110, null, null])
  const laterStart = buildHousingLevelHistory([levelRecord('2011-02', 100, 100), levelRecord('2011-03', 110, 110)])
  assert.ok(laterStart.every((record) => record.newHome.levelIndex === null && record.resale.levelIndex === null))
})

test('defensive date ordering and corrections preserve the fixed base across calendar years', () => {
  const input = Array.from({ length: 13 }, (_, index) => levelRecord(`${2011 + Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`, 100, 100)).reverse()
  input.push(levelRecord('2011-12', 110, 90), levelRecord('2011-13', 500, 500))
  const levels = buildHousingLevelHistory(input)
  assert.equal(levels.length, 13)
  assert.equal(levels[0].newHome.levelIndex, 100)
  assert.equal(levels.at(-1).month, '2012-01')
  assert.equal(levels.at(-1).newHome.levelIndex, 110)
  assert.equal(levels.at(-1).resale.levelIndex, 90)
  const absentProperty = buildHousingLevelHistory([levelRecord('2011-01', null, 100, null, 100), levelRecord('2011-02', 110, 100)])
  assert.deepEqual(absentProperty.map((record) => record.newHome.levelIndex), [null, null])
})

test('live, warm cached, and offline responses share identical full-history price levels and base metadata', async () => {
  let time = NOW
  let offline = false
  const monthly = ['2011-01', '2011-02', '2011-03'].flatMap((month, index) => ['北京', '上海'].map((city) => row(city, month, { FIRST_COMHOUSE_SEQUENTIAL: [130, 110, 90][index], SECOND_HOUSE_SEQUENTIAL: [160, 110, 90][index] })))
  const client = createHousingClient({ ...options, now: () => time, fetchImpl: async () => {
    if (offline) throw new Error('offline')
    return payload(monthly)
  } })
  const live = await client()
  assert.equal(live.levelBaseMonth, '2011-01')
  assert.equal(live.levelBaseValue, 100)
  assert.deepEqual(live.cities[0].records.map((record) => record.newHome.levelIndex), [100, 110, 99])
  const warm = await client()
  assert.deepEqual(warm.cities, live.cities)
  time += 6 * 60 * 60_000
  offline = true
  const stale = await client()
  assert.equal(stale.isStale, true)
  assert.deepEqual(stale.cities, live.cities)
  assert.equal(stale.levelBaseMonth, live.levelBaseMonth)
})

test('correct new commercial home fields remain separate from resale, other home classes, and shifting base columns', () => {
  const [city] = normalizeHousingRows([row('北京', '2026-08', {
    FIRST_HOUSE_SEQUENTIAL: 888,
    FIRST_HOUSE_SAME: 777,
    FIRST_COMHOUSE_BASE: 999,
    SECOND_HOUSE_BASE: 666,
  })], NOW)
  assert.deepEqual(city.records[0], { month: '2026-08', newHome: { momIndex: 99.8, yoyIndex: 97.7 }, resale: { momIndex: 99.9, yoyIndex: 96.5 } })
  assert.throws(() => normalizeHousingRows([{ CITY: '北京', REPORT_DATE: '2026-08-01', FIRST_HOUSE_SEQUENTIAL: 101, FIRST_COMHOUSE_BASE: 190 }], NOW), /字段不匹配/)
})

test('monthly dates are sorted, unique, and restricted to completed valid periods of the comparable 2011 series', () => {
  const cities = normalizeHousingRows([
    row('北京', '2026-08'),
    row('北京', '2011-01'),
    row('北京', '2026-08', { FIRST_COMHOUSE_SEQUENTIAL: 99.7 }),
    row('北京', '2010-12'),
    row('北京', '2026-13'),
    row('北京', '2026-10'),
    row('北京', '2026-11'),
    row('北京', '2026-02', { REPORT_DATE: '2026-02-30 00:00:00' }),
    row('其他城市', '2026-08'),
  ], NOW)
  assert.deepEqual(cities[0].records.map((record) => record.month), ['2011-01', '2026-08'])
  assert.equal(cities[0].records[1].newHome.momIndex, 99.7)
  const justAfterBeijingMidnight = Date.parse('2026-10-01T00:05:00+08:00')
  assert.equal(normalizeHousingRows([row('北京', '2026-09')], justAfterBeijingMidnight)[0].records[0].month, '2026-09')
})

test('missing, malformed, nonpositive metrics remain null, while 100 represents unchanged prices', () => {
  const [city] = normalizeHousingRows([row('北京', '2026-08', {
    FIRST_COMHOUSE_SEQUENTIAL: '100', FIRST_COMHOUSE_SAME: '', SECOND_HOUSE_SEQUENTIAL: null, SECOND_HOUSE_SAME: false,
  }), row('北京', '2026-07', {
    FIRST_COMHOUSE_SEQUENTIAL: [101], FIRST_COMHOUSE_SAME: 0, SECOND_HOUSE_SEQUENTIAL: -3, SECOND_HOUSE_SAME: Infinity,
  })], NOW)
  assert.equal(city.records.length, 1)
  assert.deepEqual(city.records[0].newHome, { momIndex: 100, yoyIndex: null })
  assert.deepEqual(city.records[0].resale, { momIndex: null, yoyIndex: null })
})

test('all history pages are fetched exactly once for concurrent requests, and cached for six hours', async () => {
  let time = NOW
  const called = []
  const client = createHousingClient({ ...options, now: () => time, fetchImpl: async (address) => {
    const url = new URL(address)
    assert.equal(url.searchParams.get('reportName'), 'RPT_ECONOMY_HOUSE_PRICE')
    assert.ok(url.searchParams.get('columns').includes('FIRST_COMHOUSE_SEQUENTIAL'))
    const page = Number(url.searchParams.get('pageNumber'))
    called.push(page)
    return payload(page === 1 ? observations.slice(2) : observations.slice(0, 2), 2, 4)
  } })
  const results = await Promise.all([client(), client(), client()])
  assert.deepEqual(called, [1, 2])
  assert.equal(results[0].isStale, false)
  assert.equal(results[0].historyStart, '2011-01')
  assert.equal(results[0].latestMonth, '2026-08')
  assert.equal(results[0].cities.length, 2)
  assert.equal(results[0].cities[0].records.length, 2)
  time += 5 * 60 * 60_000
  await client()
  assert.equal(called.length, 2)
  time += 60 * 60_000
  await client()
  assert.deepEqual(called, [1, 2, 1, 2])
})

test('incomplete and duplicate pagination or unequal latest-month coverage cannot replace valid history', async () => {
  for (const broken of [
    { data: observations.slice(0, 3), count: 4 },
    { data: [...observations.slice(0, 3), observations[2]], count: 4 },
    { data: observations.slice(0, 3), count: 3 },
  ]) {
    let time = NOW
    let brokenSource = false
    const client = createHousingClient({ ...options, now: () => time, fetchImpl: async () => brokenSource ? payload(broken.data, 1, broken.count) : payload(observations) })
    const original = await client()
    time += 6 * 60 * 60_000
    brokenSource = true
    const fallback = await client()
    assert.equal(fallback.isStale, true)
    assert.equal(fallback.asOf, original.asOf)
    assert.deepEqual(fallback.cities, original.cities)
  }
})

test('a source with valid page counts cannot shrink saved history or replace known metrics with missing values', async () => {
  const fullHistory = [
    ...observations,
    row('北京', '2020-01'), row('上海', '2020-01'),
  ]
  for (const broken of [
    fullHistory.filter((record) => record.REPORT_DATE.startsWith('2026-08')),
    fullHistory.filter((record) => !(record.CITY === '北京' && record.REPORT_DATE.startsWith('2020-01'))),
    fullHistory.map((record) => record.CITY === '北京' && record.REPORT_DATE.startsWith('2020-01')
      ? { ...record, FIRST_COMHOUSE_SEQUENTIAL: null } : record),
  ]) {
    let time = NOW
    let currentSource = fullHistory
    const client = createHousingClient({ ...options, now: () => time, fetchImpl: async () => payload(currentSource) })
    const original = await client()
    time += 6 * 60 * 60_000
    currentSource = broken
    const fallback = await client()
    assert.equal(fallback.isStale, true)
    assert.equal(fallback.asOf, original.asOf)
    assert.deepEqual(fallback.cities, original.cities)
  }
})

test('a cold provider response must include the start of the comparable series for every city', async () => {
  const client = createHousingClient({ ...options, fetchImpl: async () => payload(observations.slice(2)) })
  await assert.rejects(client(), /2011年1月/)
})

test('source failure retains real observations and timestamps; retry backoff keeps stale status', async () => {
  let time = NOW
  let calls = 0
  const client = createHousingClient({ ...options, now: () => time, fetchImpl: async () => {
    calls++
    if (calls > 1) throw new Error('offline')
    return payload(observations)
  } })
  const original = await client()
  time += 6 * 60 * 60_000
  const fallback = await client()
  assert.equal(fallback.isStale, true)
  assert.equal(fallback.asOf, original.asOf)
  assert.match(fallback.note, /历史数据/)
  await client()
  assert.equal(calls, 2)
  time += 60_000
  await client()
  assert.equal(calls, 3)
})

test('bundled complete history works during a cold offline start, without claiming a fresh retrieval', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'housing-index-'))
  try {
    const snapshotFile = join(directory, 'snapshot.json')
    await writeFile(snapshotFile, JSON.stringify(makeHousingSnapshot(normalizeHousingRows(observations, NOW), NOW - 24 * 60 * 60_000)))
    const client = createHousingClient({ ...options, snapshotFile, fetchImpl: async () => { throw new Error('offline') } })
    const result = await client()
    assert.equal(result.isStale, true)
    assert.equal(result.asOf, (NOW - 24 * 60 * 60_000) / 1000)
    assert.equal(result.historyStart, '2011-01')
    assert.equal(result.latestMonth, '2026-08')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('cold outages and invalid source envelopes fail explicitly rather than fabricate index values', async () => {
  const offline = createHousingClient({ ...options, fetchImpl: async () => { throw new Error('offline') } })
  await assert.rejects(offline(), /暂不可用/)
  const invalid = createHousingClient({ ...options, fetchImpl: async () => new Response(JSON.stringify({ success: false, result: { data: observations, pages: 1, count: 4 } })) })
  await assert.rejects(invalid(), /分页格式异常/)
  const timeout = createHousingClient({ ...options, timeoutMs: 5, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))) })
  await assert.rejects(timeout(), /请求超时/)
})
