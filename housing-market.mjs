import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DATA_API = 'https://datacenter-web.eastmoney.com/api/data/v1/get'
const REPORT = 'RPT_ECONOMY_HOUSE_PRICE'
const SOURCE_URL = 'https://data.eastmoney.com/cjsj/newhouse.html'
const SNAPSHOT_FILE = fileURLToPath(new URL('./data/housing-history.json', import.meta.url))
const CACHE_FILE = fileURLToPath(new URL('./data/housing-history-cache.json', import.meta.url))
const COLUMNS = 'REPORT_DATE,CITY,FIRST_COMHOUSE_SAME,FIRST_COMHOUSE_SEQUENTIAL,SECOND_HOUSE_SAME,SECOND_HOUSE_SEQUENTIAL'
const PAGE_SIZE = 500
const CITY_NAMES = '北京,上海,广州,深圳,天津,石家庄,太原,呼和浩特,沈阳,大连,长春,哈尔滨,南京,杭州,宁波,合肥,福州,厦门,南昌,济南,青岛,郑州,武汉,长沙,南宁,海口,重庆,成都,贵阳,昆明,西安,兰州,西宁,银川,乌鲁木齐,唐山,秦皇岛,包头,丹东,锦州,吉林,牡丹江,无锡,扬州,徐州,温州,金华,蚌埠,安庆,泉州,九江,赣州,烟台,济宁,洛阳,平顶山,宜昌,襄阳,岳阳,常德,韶关,湛江,惠州,桂林,北海,三亚,泸州,南充,遵义,大理'.split(',')
const CITY_SET = new Set(CITY_NAMES)
const NOTE = '国家统计局70个大中城市住宅销售价格指数，由东方财富转引，按月发布。环比以上月=100，同比以上年同月=100；减去100即涨跌百分比，不是每平方米房价。当前统计口径公开历史始于2011年1月；2011年统计制度调整，旧口径不直接拼接。2026年调整对比基期与权数，图表保留各月原始环比/同比，不拼接定基值。'

function monthFromDate(value, currentMonth) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-01(?: 00:00:00)?$/.test(value)) return null
  const month = value.slice(0, 7)
  if (month < '2011-01' || month > currentMonth || Number(month.slice(5)) < 1 || Number(month.slice(5)) > 12) return null
  return month
}

function indexValue(value) {
  if (value === '' || (typeof value !== 'number' && typeof value !== 'string')) return null
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

export function normalizeHousingRows(rows, now = Date.now()) {
  if (!Array.isArray(rows)) throw new Error('房价指数数据格式异常')
  // The current calendar month has not finished and cannot be an NBS monthly observation yet.
  const beijingDate = new Date(now + 8 * 60 * 60_000)
  const currentMonth = new Date(Date.UTC(beijingDate.getUTCFullYear(), beijingDate.getUTCMonth() - 1, 1)).toISOString().slice(0, 7)
  const cities = new Map()
  for (const row of rows) {
    const month = monthFromDate(row?.REPORT_DATE, currentMonth)
    if (!month || !CITY_SET.has(row?.CITY)) continue
    const newHome = { momIndex: indexValue(row.FIRST_COMHOUSE_SEQUENTIAL), yoyIndex: indexValue(row.FIRST_COMHOUSE_SAME) }
    const resale = { momIndex: indexValue(row.SECOND_HOUSE_SEQUENTIAL), yoyIndex: indexValue(row.SECOND_HOUSE_SAME) }
    if (Object.values(newHome).concat(Object.values(resale)).every((value) => value === null)) continue
    if (!cities.has(row.CITY)) cities.set(row.CITY, new Map())
    cities.get(row.CITY).set(month, { month, newHome, resale })
  }
  const result = CITY_NAMES.filter((name) => cities.has(name)).map((name) => ({
    id: name,
    name,
    records: [...cities.get(name).values()].sort((a, b) => a.month.localeCompare(b.month)),
  }))
  if (!result.length) throw new Error('房价指数数据为空或字段不匹配')
  return result
}

function packedRows(cities) {
  return cities.flatMap((city) => city.records.map((row) => [row.month, city.name, row.newHome.momIndex, row.newHome.yoyIndex, row.resale.momIndex, row.resale.yoyIndex]))
}

function unpackRows(rows) {
  if (!Array.isArray(rows)) throw new Error('房价历史快照格式异常')
  return rows.map((row) => ({
    REPORT_DATE: Array.isArray(row) && typeof row[0] === 'string' ? `${row[0]}-01` : null,
    CITY: row?.[1],
    FIRST_COMHOUSE_SEQUENTIAL: row?.[2],
    FIRST_COMHOUSE_SAME: row?.[3],
    SECOND_HOUSE_SEQUENTIAL: row?.[4],
    SECOND_HOUSE_SAME: row?.[5],
  }))
}

function validateCoverage(cities, expectedCities) {
  const latestMonth = cities.reduce((latest, city) => city.records.at(-1).month > latest ? city.records.at(-1).month : latest, '')
  if (cities.length !== expectedCities || cities.filter((city) => city.records.at(-1).month === latestMonth).length !== expectedCities) {
    throw new Error('房价指数城市或最新月份数据不完整')
  }
  if (cities.some((city) => city.records[0].month !== '2011-01')) {
    throw new Error('房价指数历史未覆盖2011年1月起始期')
  }
  return latestMonth
}

function preserveExistingCoverage(previous, fresh) {
  if (!previous) return
  const observations = new Map(fresh.map((city) => [city.id, new Map(city.records.map((record) => [record.month, record]))]))
  for (const city of previous) {
    for (const record of city.records) {
      const replacement = observations.get(city.id)?.get(record.month)
      if (!replacement) throw new Error('房价数据源删除了已保存的历史月份')
      for (const housingType of ['newHome', 'resale']) {
        for (const metric of ['momIndex', 'yoyIndex']) {
          if (record[housingType][metric] !== null && replacement[housingType][metric] === null) {
            throw new Error('房价数据源缺失已保存的历史指标')
          }
        }
      }
    }
  }
}

export function makeHousingSnapshot(cities, fetchedAt = Date.now()) {
  return { source: REPORT, version: 1, fetchedAt, columns: ['month', 'city', 'newHomeMomIndex', 'newHomeYoyIndex', 'resaleMomIndex', 'resaleYoyIndex'], rows: packedRows(cities) }
}

async function saveFile(path, snapshot) {
  if (!path) return
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(snapshot), 'utf8')
  await rename(temporary, path)
}

function responseFor(cached, isStale) {
  const latestMonth = cached.cities.reduce((latest, city) => city.records.at(-1).month > latest ? city.records.at(-1).month : latest, '')
  const historyStart = cached.cities.reduce((first, city) => city.records[0].month < first ? city.records[0].month : first, latestMonth)
  return {
    asOf: Math.floor(cached.fetchedAt / 1000),
    latestMonth,
    historyStart,
    sourceName: '国家统计局 / 东方财富Choice转引',
    sourceUrl: SOURCE_URL,
    frequency: '每月发布',
    isStale,
    note: isStale ? `数据源暂时连接失败，正在显示已保存的真实历史数据。${NOTE}` : NOTE,
    cities: cached.cities,
  }
}

export function createHousingClient({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  cacheFile = CACHE_FILE,
  snapshotFile = SNAPSHOT_FILE,
  cacheTtlMs = 6 * 60 * 60_000,
  retryTtlMs = 60_000,
  timeoutMs = 20_000,
  expectedCities = 70,
} = {}) {
  let cached = null
  let diskLoad = null
  let pending = null
  let lastFailedAt = null

  async function readSavedData() {
    for (const path of [cacheFile, snapshotFile]) {
      if (!path) continue
      try {
        const saved = JSON.parse(await readFile(path, 'utf8'))
        if (saved.source !== REPORT || saved.version !== 1 || !Number.isFinite(saved.fetchedAt) || saved.fetchedAt > now()) continue
        const cities = normalizeHousingRows(unpackRows(saved.rows), now())
        validateCoverage(cities, expectedCities)
        if (!cached || saved.fetchedAt > cached.fetchedAt) cached = { cities, fetchedAt: saved.fetchedAt, bundled: path === snapshotFile }
      } catch {
        // Invalid local data must not become a manufactured zero or a partial nationwide view.
      }
    }
  }

  async function refresh() {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    async function page(number) {
      const url = new URL(DATA_API)
      url.search = new URLSearchParams({ reportName: REPORT, columns: COLUMNS, pageSize: String(PAGE_SIZE), pageNumber: String(number), sortColumns: 'REPORT_DATE,CITY', sortTypes: '-1,1', source: 'WEB', client: 'WEB' })
      const result = await fetchImpl(url.toString(), { signal: controller.signal, headers: { Referer: SOURCE_URL, 'User-Agent': 'Mozilla/5.0 Market Dashboard' } })
      if (!result.ok) throw new Error(`房价数据源返回 ${result.status}`)
      const payload = await result.json()
      if (payload.success !== true || !Array.isArray(payload.result?.data) || !Number.isInteger(payload.result.pages) || !Number.isInteger(payload.result.count) || payload.result.pages < 1 || payload.result.pages > 120 || payload.result.count < 1) {
        throw new Error('房价数据源分页格式异常')
      }
      return payload.result
    }
    try {
      const first = await page(1)
      const rows = [...first.data]
      for (let start = 2; start <= first.pages; start += 4) {
        const pageNumbers = Array.from({ length: Math.min(4, first.pages - start + 1) }, (_, index) => start + index)
        const results = await Promise.all(pageNumbers.map(page))
        for (const result of results) {
          if (result.pages !== first.pages || result.count !== first.count) throw new Error('房价数据源分页在请求中发生变化')
          rows.push(...result.data)
        }
      }
      // Never silently limit the history to the first page, or overwrite a complete cache with an incomplete download.
      if (rows.length !== first.count) throw new Error('房价数据源历史分页不完整')
      const identities = new Set(rows.map((row) => `${row?.CITY}:${row?.REPORT_DATE}`))
      if (identities.size !== rows.length) throw new Error('房价数据源分页包含重复记录')
      const cities = normalizeHousingRows(rows, now())
      validateCoverage(cities, expectedCities)
      preserveExistingCoverage(cached?.cities, cities)
      cached = { cities, fetchedAt: now(), bundled: false }
      lastFailedAt = null
      try { await saveFile(cacheFile, makeHousingSnapshot(cities, cached.fetchedAt)) } catch { /* A read-only disk must not discard a valid source response. */ }
      return responseFor(cached, false)
    } catch (error) {
      controller.abort()
      lastFailedAt = now()
      if (cached) return responseFor(cached, true)
      throw new Error(`房价指数暂不可用：${error.name === 'AbortError' ? '请求超时' : error.message}`)
    } finally {
      clearTimeout(timer)
    }
  }

  return async function fetchHousingData() {
    if (!diskLoad) diskLoad = readSavedData()
    await diskLoad
    if (lastFailedAt !== null && now() - lastFailedAt < retryTtlMs && cached) return responseFor(cached, true)
    if (cached && !cached.bundled && lastFailedAt === null && now() - cached.fetchedAt < cacheTtlMs) return responseFor(cached, false)
    if (!pending) pending = refresh().finally(() => { pending = null })
    return pending
  }
}

export const fetchHousingData = createHousingClient()
