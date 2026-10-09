import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DATA_API = 'https://datacenter-web.eastmoney.com/api/data/v1/get'
const REPORT = 'RPT_ECONOMY_ASSET_INVEST'
const AMOUNT_SOURCE_URL = 'https://data.eastmoney.com/cjsj/gdzctz.html'
const OFFICIAL_LIST_URL = 'https://www.stats.gov.cn/sj/zxfbhjd/'
const SNAPSHOT_FILE = fileURLToPath(new URL('./data/fixed-investment-history.json', import.meta.url))
const ANNUAL_SNAPSHOT_FILE = fileURLToPath(new URL('./data/annual-fixed-investment-history.json', import.meta.url))
const CACHE_FILE = fileURLToPath(new URL('./data/fixed-investment-history-cache.json', import.meta.url))
const ANNUAL_REPORT = 'NBS_ANNUAL_FIXED_INVESTMENT'
const HISTORY_START = '2012-02'
const NOTE = '全国固定资产投资（不含农户），金额单位为亿元，表示当年1月至所选月份的累计完成额，每年重新累计；它是投资流量，不是固定资产存量。1月份免报，2月份为1—2月合计。公开转引金额历史始于2012年2月。累计同比仅采用国家统计局公报公布的可比口径增速，未取得的月份留空，不根据金额相除或转引单月增速推算。统计制度与比较基数会修订，跨年金额并非完全可比。'

function numeric(value, positive = false) {
  if (value === '' || (typeof value !== 'number' && typeof value !== 'string')) return null
  const result = Number(value)
  return Number.isFinite(result) && (!positive || result > 0) ? result : null
}

function validMonth(value, now) {
  if (typeof value !== 'string' || !/^\d{4}-(?:0[2-9]|1[0-2])$/.test(value)) return false
  const date = new Date(now + 8 * 60 * 60_000)
  const lastCompleted = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1)).toISOString().slice(0, 7)
  return value >= HISTORY_START && value <= lastCompleted
}

function officialRows(observations, now, allowMissingYoy = false) {
  const result = new Map()
  for (const observation of observations ?? []) {
    if (!validMonth(observation?.month, now) || numeric(observation.amount, true) === null || (!allowMissingYoy && numeric(observation.yoy) === null) || !/^\d{4}-\d{2}-\d{2}$/.test(observation.releaseDate ?? '')) continue
    try {
      const url = new URL(observation.sourceUrl)
      if (url.protocol !== 'https:' || url.hostname !== 'www.stats.gov.cn' || !url.pathname.endsWith('.html')) continue
      const releaseTime = Date.parse(`${observation.releaseDate}T00:00:00+08:00`)
      if (!Number.isFinite(releaseTime) || releaseTime > now || new Date(releaseTime + 8 * 60 * 60_000).toISOString().slice(0, 10) !== observation.releaseDate) continue
      result.set(observation.month, { month: observation.month, amount: Number(observation.amount), yoy: numeric(observation.yoy), releaseDate: observation.releaseDate, sourceUrl: url.toString() })
    } catch { /* Only attributable official observations can supply the comparable YoY series. */ }
  }
  return result
}

export function normalizeAnnualFixedInvestmentRecords(observations, now = Date.now()) {
  if (!Array.isArray(observations)) throw new Error('固定资产投资年度数据格式异常')
  const lastCompletedYear = new Date(now + 8 * 60 * 60_000).getUTCFullYear() - 1
  const unique = new Map()
  for (const observation of observations) {
    if (!Number.isInteger(observation?.year) || observation.year < 2012 || observation.year > lastCompletedYear) continue
    const month = `${observation.year}-12`
    const official = officialRows([{ ...observation, month }], now, true).get(month)
    if (!official || Number(official.releaseDate.slice(0, 4)) <= observation.year) continue
    // Both amounts and YoY are the annual release's original values; never infer growth from adjacent amounts.
    unique.set(observation.year, { year: observation.year, amount: official.amount, yoy: official.yoy, releaseDate: official.releaseDate, sourceUrl: official.sourceUrl })
  }
  return [...unique.values()].sort((a, b) => a.year - b.year)
}

export function makeAnnualFixedInvestmentSnapshot(records, fetchedAt = Date.now()) {
  return { source: ANNUAL_REPORT, version: 1, fetchedAt, records: records.map((record) => ({ ...record })) }
}

export function normalizeFixedInvestmentRows(rows, observations = [], now = Date.now()) {
  if (!Array.isArray(rows)) throw new Error('固定资产投资数据格式异常')
  const records = new Map()
  for (const row of rows) {
    if (typeof row?.REPORT_DATE !== 'string' || !/^\d{4}-\d{2}-01(?: 00:00:00)?$/.test(row.REPORT_DATE)) continue
    const month = row.REPORT_DATE.slice(0, 7)
    const amount = numeric(row.BASE_ACCUMULATE, true)
    if (!validMonth(month, now) || amount === null) continue
    // BASE, BASE_SAME and BASE_SEQUENTIAL are a different (single-month) series.
    records.set(month, { month, amount, yoy: null })
  }
  for (const [month, official] of officialRows(observations, now)) {
    if (records.has(month) && Math.abs(records.get(month).amount - official.amount) > 0.01) throw new Error(`固定资产投资${month}转引金额与官方公报不一致`)
    records.set(month, { ...official })
  }
  const sorted = [...records.values()].sort((a, b) => a.month.localeCompare(b.month))
  if (!sorted.length) throw new Error('固定资产投资数据为空或字段不匹配')
  return sorted
}

function validateCoverage(records, expectedStart) {
  if (records[0].month !== expectedStart) throw new Error(`固定资产投资历史未覆盖${expectedStart}起始期`)
  const months = new Set(records.map((record) => record.month))
  const latest = records.at(-1).month
  for (let year = Number(expectedStart.slice(0, 4)); year <= Number(latest.slice(0, 4)); year++) {
    for (let month = 2; month <= 12; month++) {
      const key = `${year}-${String(month).padStart(2, '0')}`
      if (key >= expectedStart && key <= latest && !months.has(key)) throw new Error(`固定资产投资历史缺少${key}`)
    }
  }
}

function preserveCoverage(previous, fresh) {
  const byMonth = new Map(fresh.map((record) => [record.month, record]))
  for (const record of previous ?? []) {
    const replacement = byMonth.get(record.month)
    if (!replacement || (record.amount !== null && replacement.amount === null) || (record.yoy !== null && replacement.yoy === null)) throw new Error('固定资产投资数据源删除了已保存的历史指标')
  }
}

export function parseOfficialFixedInvestment(html, sourceUrl) {
  const text = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&[^;]+;/g, ' ').replace(/\s+/g, '')
  const title = text.match(/(\d{4})年1[—–－\-至~～](\d{1,2})月份全国固定资产投资基本情况/) ?? text.match(/(\d{4})年全国固定资产投资基本情况/)
  const values = text.match(/全国固定资产投资[（(]不含农户[）)]([\d,.]+)亿元，(?:同比|比上年)(增长|下降)([\d.]+)%/)
  const released = text.match(/(\d{4})[/-](\d{2})[/-](\d{2})\d{2}:\d{2}/)
  if (!title || !values || !released) throw new Error('国家统计局固定资产投资公报字段不匹配')
  return { month: `${title[1]}-${(title[2] ?? '12').padStart(2, '0')}`, amount: Number(values[1].replaceAll(',', '')), yoy: Number(values[3]) * (values[2] === '下降' ? -1 : 1), releaseDate: `${released[1]}-${released[2]}-${released[3]}`, sourceUrl }
}

export function makeFixedInvestmentSnapshot(records, fetchedAt = Date.now(), annualRecords = []) {
  return { source: REPORT, version: 1, fetchedAt, columns: ['month', 'amount'], rows: records.map((record) => [record.month, record.amount]), officialObservations: records.filter((record) => record.yoy !== null).map((record) => ({ ...record })), annualRecords: annualRecords.map((record) => ({ ...record })) }
}

async function saveFile(path, snapshot) {
  if (!path) return
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(snapshot), 'utf8')
  await rename(temporary, path)
}

function responseFor(cached, isStale, annualRecords) {
  const latest = cached.records.at(-1)
  return {
    asOf: Math.floor(cached.fetchedAt / 1000), latestMonth: latest.month, historyStart: cached.records[0].month,
    sourceName: '国家统计局 / 东方财富Choice转引（累计金额）', sourceUrl: latest.sourceUrl ?? AMOUNT_SOURCE_URL,
    amountSourceUrl: AMOUNT_SOURCE_URL, officialSourceUrl: OFFICIAL_LIST_URL,
    frequency: '每月发布（1月份免报）', isStale, ...(latest.releaseDate ? { releaseDate: latest.releaseDate } : {}),
    ...(latest.sourceUrl ? { releaseSourceUrl: latest.sourceUrl } : {}),
    note: isStale ? `显示已保存的真实历史数据，后台正在重试同步。${NOTE}` : NOTE,
    records: cached.records.map((record) => ({ ...record })),
    annualRecords: annualRecords.map((record) => ({ ...record })),
    annualSourceName: '国家统计局年度公报（全年发布值）',
    annualNote: '年度趋势仅包含完整年度，金额为当年全年公报发布值，累计同比直接采用公报公布的可比口径增速。历史金额及比较基数可能修订，年度公报发布值与月度转引年末值可能不同；不通过相邻金额相除计算同比。本年尚未公布的全年数据不并入年度趋势。',
  }
}

export function createFixedInvestmentClient({
  fetchImpl = globalThis.fetch, now = Date.now, cacheFile = CACHE_FILE, snapshotFile = SNAPSHOT_FILE, annualSnapshotFile = ANNUAL_SNAPSHOT_FILE,
  cacheTtlMs = 6 * 60 * 60_000, retryTtlMs = 60_000, timeoutMs = 12_000,
  officialTimeoutMs = 5_000, expectedStart = HISTORY_START, officialEnabled = true,
} = {}) {
  let cached = null
  let annualRecords = []
  let diskLoad = null
  let pending = null
  let lastFailedAt = null

  async function readSavedData() {
    if (annualSnapshotFile) {
      try {
        const saved = JSON.parse(await readFile(annualSnapshotFile, 'utf8'))
        if (saved.source === ANNUAL_REPORT && saved.version === 1 && Number.isFinite(saved.fetchedAt) && saved.fetchedAt <= now()) annualRecords = normalizeAnnualFixedInvestmentRecords(saved.records, now())
      } catch { /* An unavailable annual snapshot must not block otherwise valid monthly history. */ }
    }
    for (const path of [cacheFile, snapshotFile]) {
      if (!path) continue
      try {
        const saved = JSON.parse(await readFile(path, 'utf8'))
        if (saved.source !== REPORT || saved.version !== 1 || !Number.isFinite(saved.fetchedAt) || saved.fetchedAt > now() || !Array.isArray(saved.rows)) continue
        const rows = saved.rows.map((row) => ({ REPORT_DATE: `${row?.[0]}-01`, BASE_ACCUMULATE: row?.[1] }))
        const records = normalizeFixedInvestmentRows(rows, saved.officialObservations, now())
        validateCoverage(records, expectedStart)
        annualRecords = normalizeAnnualFixedInvestmentRecords([...annualRecords, ...(saved.annualRecords ?? [])], now())
        annualRecords = normalizeAnnualFixedInvestmentRecords([...annualRecords, ...records.filter((record) => record.month.endsWith('-12') && record.yoy !== null).map((record) => ({ ...record, year: Number(record.month.slice(0, 4)) }))], now())
        if (!cached || saved.fetchedAt > cached.fetchedAt) cached = { records, fetchedAt: saved.fetchedAt }
      } catch { /* Invalid snapshots must never become invented zero-valued investment observations. */ }
    }
  }

  async function fetchOfficialObservation() {
    if (!officialEnabled) return null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), officialTimeoutMs)
    try {
      const options = { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 Market Dashboard' } }
      const listResponse = await fetchImpl(OFFICIAL_LIST_URL, options)
      if (!listResponse.ok) throw new Error('国家统计局发布列表不可用')
      const list = await listResponse.text()
      const anchors = list.match(/<a\b[^>]*href=["'][^"']+["'][^>]*>[\s\S]*?<\/a>/gi) ?? []
      const link = anchors.find((anchor) => /\d{4}年(?:1[—–－\-至~～]\d{1,2}月份)?全国固定资产投资基本情况/.test(anchor))
      const href = link?.match(/href=["']([^"']+)["']/i)?.[1]
      if (!href) throw new Error('国家统计局固定资产投资发布链接缺失')
      const address = new URL(href, OFFICIAL_LIST_URL)
      if (address.protocol !== 'https:' || address.hostname !== 'www.stats.gov.cn') throw new Error('国家统计局公报链接异常')
      const publication = await fetchImpl(address.toString(), options)
      if (!publication.ok) throw new Error('国家统计局固定资产投资公报不可用')
      const observation = parseOfficialFixedInvestment(await publication.text(), address.toString())
      if (!officialRows([observation], now()).size) throw new Error('国家统计局固定资产投资公报期间异常')
      return observation
    } catch {
      // The amount history can still update while unavailable official YoY observations remain null.
      return null
    } finally { clearTimeout(timer) }
  }

  async function refresh() {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    async function page(number) {
      const url = new URL(DATA_API)
      url.search = new URLSearchParams({ reportName: REPORT, columns: 'REPORT_DATE,BASE_ACCUMULATE', pageSize: '500', pageNumber: String(number), sortColumns: 'REPORT_DATE', sortTypes: '-1', source: 'WEB', client: 'WEB' })
      const result = await fetchImpl(url.toString(), { signal: controller.signal, headers: { Referer: AMOUNT_SOURCE_URL, 'User-Agent': 'Mozilla/5.0 Market Dashboard' } })
      if (!result.ok) throw new Error(`固定资产投资数据源返回${result.status}`)
      const payload = await result.json()
      const data = payload.result
      if (payload.success !== true || !Array.isArray(data?.data) || !Number.isInteger(data.pages) || !Number.isInteger(data.count) || data.pages < 1 || data.pages > 30 || data.count < 1) throw new Error('固定资产投资数据源分页格式异常')
      return data
    }
    const officialPromise = fetchOfficialObservation()
    try {
      const first = await page(1)
      const rows = [...first.data]
      for (let number = 2; number <= first.pages; number++) {
        const result = await page(number)
        if (result.pages !== first.pages || result.count !== first.count) throw new Error('固定资产投资分页在请求中发生变化')
        rows.push(...result.data)
      }
      if (rows.length !== first.count) throw new Error('固定资产投资历史分页不完整')
      if (new Set(rows.map((row) => row?.REPORT_DATE)).size !== rows.length) throw new Error('固定资产投资历史分页包含重复记录')
      const official = await officialPromise
      const annualOfficial = official?.month.endsWith('-12') ? [{ ...official, year: Number(official.month.slice(0, 4)) }] : []
      const nextAnnualRecords = normalizeAnnualFixedInvestmentRecords([...annualRecords, ...annualOfficial], now())
      // Full-year official releases have their own published-value series. Do not compare old annual
      // release amounts to later-revised Choice December amounts or overwrite the monthly series.
      const observations = [...(cached?.records.filter((record) => record.yoy !== null) ?? []), ...(official && !official.month.endsWith('-12') ? [official] : [])]
      const records = normalizeFixedInvestmentRows(rows, observations, now())
      validateCoverage(records, expectedStart)
      preserveCoverage(cached?.records, records)
      cached = { records, fetchedAt: now() }
      annualRecords = nextAnnualRecords
      lastFailedAt = null
      try { await saveFile(cacheFile, makeFixedInvestmentSnapshot(records, cached.fetchedAt, annualRecords)) } catch { /* Valid source data remains usable on a read-only disk. */ }
      return responseFor(cached, false, annualRecords)
    } catch (error) {
      controller.abort()
      lastFailedAt = now()
      if (cached) return responseFor(cached, true, annualRecords)
      throw new Error(`固定资产投资暂不可用：${error.name === 'AbortError' ? '请求超时' : error.message}`)
    } finally { clearTimeout(timer) }
  }

  function startRefresh() {
    if (!pending) pending = refresh().finally(() => { pending = null })
    return pending
  }

  return async function fetchFixedInvestmentData({ force = false } = {}) {
    if (!diskLoad) diskLoad = readSavedData()
    await diskLoad
    if (force) return startRefresh()
    if (lastFailedAt !== null && now() - lastFailedAt < retryTtlMs && cached) return responseFor(cached, true, annualRecords)
    if (cached && lastFailedAt === null && now() - cached.fetchedAt < cacheTtlMs) return responseFor(cached, false, annualRecords)
    if (cached) {
      // Render all saved observations immediately; network latency must not block the dashboard.
      startRefresh().catch(() => {})
      return responseFor(cached, true, annualRecords)
    }
    return startRefresh()
  }
}

export const fetchFixedInvestmentData = createFixedInvestmentClient()
