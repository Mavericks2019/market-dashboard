import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createCfetsClient } from './cfets-market.mjs'

const row = (date, value) => ({ showDateCn: date, indexRate: value })
const history = [row('2015-11-30', 102.93), row('2026-09-18', 102.54), row('2026-09-24', 102.93)]
const response = (rows = history) => ({ ok: true, json: async () => ({ head: { rep_code: '200' }, records: rows }) })

test('official observations are sorted, deduplicated and preserve null OHLC', async () => {
  const client = createCfetsClient({ cacheFile: null, fetchImpl: async () => response([
    history[2], history[0], row('2026-09-18', 102.5), history[1],
    row('2026-02-30', 101), row('bad date', 101), row('2026-09-20', null),
  ]) })
  const market = await client()
  assert.equal(market.key, 'CFETS')
  assert.equal(market.points.length, 3)
  assert.equal(market.points[1].close, 102.54)
  assert.equal(market.change, 0.39)
  assert.equal(market.price, 102.93)
  assert.equal(market.dayHigh, null)
  assert.equal(market.isStale, false)
  assert(market.points.every((point) => point.open === null && point.high === null && point.low === null && point.volume === null))
  assert.equal(new Date(market.historyStart * 1000).toISOString().slice(0, 10), '2015-11-30')
})

test('short ranges show real releases and retain the complete history start and change', async () => {
  const client = createCfetsClient({ cacheFile: null, fetchImpl: async () => response() })
  const all = await client('MAX')
  const latest = await client('1D')
  const fiveDays = await client('5D')
  const oneMonth = await client('1M')
  assert.equal(latest.points.length, 1)
  assert.equal(fiveDays.points.length, 1)
  assert.equal(oneMonth.points.length, 2)
  assert.equal(latest.historyStart, all.historyStart)
  assert.equal(latest.previousClose, all.previousClose)
  assert.equal(latest.change, 0.39)
  await assert.rejects(client('UNKNOWN'), /不支持/)
})

test('concurrent ranges share one upstream fetch', async () => {
  let calls = 0
  const client = createCfetsClient({ cacheFile: null, fetchImpl: async () => { calls += 1; return response() } })
  await Promise.all([client('MAX'), client('1D'), client('1Y')])
  assert.equal(calls, 1)
})

test('a network failure exposes stale cached data and preserves its retrieval time', async () => {
  let time = 1_000
  let calls = 0
  const client = createCfetsClient({ cacheFile: null, now: () => time, cacheTtlMs: 100, fetchImpl: async () => {
    calls += 1
    if (calls > 1) throw new Error('offline')
    return response()
  } })
  const first = await client()
  time = 2_000
  const stale = await client()
  assert.equal(stale.isStale, true)
  assert.equal(stale.fetchedAt, first.fetchedAt)
  assert.match(stale.dataNote, /历史缓存/)
  assert.deepEqual(stale.points, first.points)
})

test('empty official data without a cache fails instead of creating observations', async () => {
  const client = createCfetsClient({ cacheFile: null, fetchImpl: async () => response([]) })
  await assert.rejects(client(), /CFETS 官方数据暂不可用.*为空/)
})

test('persistent observations survive restart with an explicit stale marker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cfets-test-'))
  try {
    const cacheFile = join(dir, 'history.json')
    const firstClient = createCfetsClient({ cacheFile, now: () => 1_000, fetchImpl: async () => response() })
    const first = await firstClient()
    const secondClient = createCfetsClient({ cacheFile, now: () => 2_000, cacheTtlMs: 100, fetchImpl: async () => { throw new Error('offline') } })
    const second = await secondClient()
    assert.equal(second.isStale, true)
    assert.deepEqual(second.points, first.points)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a hung official request is aborted at the timeout', async () => {
  const client = createCfetsClient({ cacheFile: null, timeoutMs: 20, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
  }) })
  await assert.rejects(client(), /请求超时/)
})
