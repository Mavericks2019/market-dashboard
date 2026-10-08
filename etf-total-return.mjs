const ETF = {
  key: 'NF_DIV_LV50', fundCode: '515450', name: '南方红利低波50ETF',
  sourceNames: ['红利低波50ETF南方', '南方标普中国A股大盘红利低波50ETF'],
  inceptionDate: '2020-01-17', kind: 'etf',
}
export const FUND_LINK_INSTRUMENTS = {
  NF_DIV_LV50_A: {
    key: 'NF_DIV_LV50_A', fundCode: '008163', symbol: '008163', name: '南方红利低波50ETF联接A',
    englishName: 'Southern Dividend Low Volatility 50 ETF Feeder A',
    sourceNames: ['南方标普红利低波50ETF联接A', '南方标普中国A股大盘红利低波50ETF联接A'],
    contract: '南方标普中国A股大盘红利低波50交易型开放式指数证券投资基金联接基金（A类份额）',
    kind: 'fund', unit: 'CNY/份', currency: 'CNY', exchange: '场外基金', exchangeTimezone: 'Asia/Shanghai',
    precision: 4, inceptionDate: '2020-01-21', frequency: '每日公布净值',
  },
}
const INSTRUMENTS = { [ETF.key]: ETF, ...FUND_LINK_INSTRUMENTS }
const PERIODS = new Set(['1D', '5D', '1M', '3M', '1Y', '5Y', 'MAX'])
const DAY = 86_400_000
const SHANGHAI_OFFSET = 8 * 3_600_000
const CACHE_TTL = 60 * 60_000
const RETRY_TTL = 60_000
const TIMEOUT = 10_000
const NAV_TOLERANCE = 0.00015 // Published unit and cumulative NAVs are rounded to four decimals.
const dividendUrl = (fund) => `https://fund.eastmoney.com/f10/fhsp_${fund.fundCode}.html`
function totalReturnNote(fund) {
  const method = fund.kind === 'fund'
    ? '该场外基金可选择现金分红或红利再投资；本曲线为按除息日净值再投的理论总回报，实际份额确认以基金公告为准。'
    : '此ETF实际派发现金；本曲线为理论总回报，不是自动再投或到账后按场内成交价买入的实绩。'
  const charges = fund.kind === 'fund' ? '未计个人申购、赎回费用及税费。' : '未计个人交易佣金、税费及折溢价。'
  return `按公布的单位净值与现金分红计算，假设除息日按当日净值立即全额再投资，起点为100。${method}基金运作费用已反映在净值中，${charges}净值按日披露、有公布延迟，不随盘中行情实时变动。`
}

function fail(message) { throw new Error(`基金数据：${message}`) }
function instrument(key = ETF.key) {
  if (!Object.hasOwn(INSTRUMENTS, key)) fail('暂不支持该基金')
  return INSTRUMENTS[key]
}

// Read only a JSON literal; never evaluate the downloaded JavaScript.
function jsonVariable(source, name) {
  const assignments = [...source.matchAll(new RegExp(`\\bvar\\s+${name}\\s*=`, 'g'))]
  if (assignments.length !== 1) fail(`${name} 缺失或重复`)
  let start = assignments[0].index + assignments[0][0].length
  while (/\s/.test(source[start] ?? '') && start < source.length) start += 1
  const first = source[start]
  if (first !== '[' && first !== '"') fail(`${name} 不是 JSON 数据`)
  let depth = 0
  let inString = false
  let escaped = false
  for (let end = start; end < source.length; end += 1) {
    const char = source[end]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
    } else if (char === '"') inString = true
    else if (char === '[' || char === '{') depth += 1
    else if (char === ']' || char === '}') depth -= 1
    if (!inString && depth === 0) {
      if (!/^\s*;/.test(source.slice(end + 1))) fail(`${name} 包含非 JSON 表达式`)
      try { return JSON.parse(source.slice(start, end + 1)) } catch { fail(`${name} JSON 格式异常`) }
    }
  }
  fail(`${name} JSON 不完整`)
}

function calendarDate(raw) {
  if (!Number.isSafeInteger(raw) || (raw + SHANGHAI_OFFSET) % DAY !== 0 || raw < 0) fail('净值日期格式异常')
  return new Date(raw + SHANGHAI_OFFSET).toISOString().slice(0, 10)
}

function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const time = Date.parse(`${date}T00:00:00Z`)
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date
}

function positive(value) { return typeof value === 'number' && Number.isFinite(value) && value > 0 }

function cashDividend(value) {
  if (value === '') return 0
  if (typeof value !== 'string') fail('现金分红标注缺失')
  const match = value.match(/^分红[：:]每份派现金(\d+(?:\.\d+)?)元$/)
  if (!match || !positive(Number(match[1]))) fail('出现无法识别的分红或拆分事件')
  return Number(match[1])
}

/** Strictly align NAV and cumulative NAV; the latter only audits dividends, never computes returns. */
export function parseEtfNavHistory(source, key = ETF.key) {
  const fund = instrument(key)
  if (typeof source !== 'string' || source.length > 2_000_000) fail('净值响应异常')
  const code = jsonVariable(source, 'fS_code')
  const name = jsonVariable(source, 'fS_name')
  if (code !== fund.fundCode || !fund.sourceNames.includes(name)) fail('基金身份校验失败')
  const net = jsonVariable(source, 'Data_netWorthTrend')
  const accumulated = jsonVariable(source, 'Data_ACWorthTrend')
  if (!Array.isArray(net) || net.length < 2 || !Array.isArray(accumulated) || accumulated.length !== net.length) fail('单位净值与累计净值日期缺失')
  let cashTotal = 0
  let previousTime = -Infinity
  const rows = net.map((point, index) => {
    if (!point || typeof point !== 'object' || !positive(point.y)) fail('单位净值无效')
    const date = calendarDate(point.x)
    if (point.x <= previousTime) fail('净值日期重复或顺序异常')
    previousTime = point.x
    const cumulative = accumulated[index]
    if (!Array.isArray(cumulative) || cumulative[0] !== point.x || !positive(cumulative[1])) fail('累计净值日期缺失或错位')
    const dividend = cashDividend(point.unitMoney)
    cashTotal += dividend
    if (Math.abs(cumulative[1] - point.y - cashTotal) > NAV_TOLERANCE) fail('现金分红漏计、重复或累计净值不一致')
    return { date, time: Date.parse(`${date}T00:00:00Z`) / 1000, nav: point.y, dividend }
  })
  if (rows[0].date !== fund.inceptionDate || rows[0].dividend !== 0) fail('净值历史未覆盖基金成立日')
  return rows
}

function cleanCell(html) { return html.replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;/g, ' ').trim() }

/** Independently check ex-dividend dates and the per-ten-unit amounts against the NAV event labels. */
export function parseEtfDividends(html, key = ETF.key) {
  const fund = instrument(key)
  if (typeof html !== 'string' || html.length > 2_000_000 || !new RegExp(`<title>[^<]*\\(${fund.fundCode}\\)[^<]*基金分红送配`).test(html)) fail('分红表基金身份校验失败')
  const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map((match) => match[1])
  const dividendTables = tables.filter((table) => /权益登记日/.test(table) && /除息日/.test(table) && /每10份分红/.test(table))
  const splitTables = tables.filter((table) => /拆分折算日/.test(table) && /拆分折算比例/.test(table))
  if (dividendTables.length !== 1 || splitTables.length !== 1) fail('分红或拆分表缺失')
  if (!/暂无拆分信息/.test(splitTables[0])) fail('基金存在拆分，需核实调整后再计算总回报')
  const rows = [...dividendTables[0].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((match) => [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => cleanCell(cell[1])))
    .filter((cells) => cells.length)
  if (!rows.length) fail('分红表为空')
  const seen = new Set()
  return rows.map((cells) => {
    const amount = cells[3]?.match(/^每10份派现金(\d+(?:\.\d+)?)元$/)
    if (cells.length !== 5 || !validDate(cells[1]) || !validDate(cells[2]) || !validDate(cells[4]) || !amount || !positive(Number(amount[1]))) fail('分红表格式异常')
    const date = cells[2]
    if (seen.has(date)) fail('分红表除息日重复')
    if (date < fund.inceptionDate || cells[1] > date || cells[4] < date) fail('分红日期顺序异常')
    seen.add(date)
    return { date, amount: Number(amount[1]) / 10 }
  }).sort((a, b) => a.date.localeCompare(b.date))
}

export function calculateEtfTotalReturn(navHistory, dividends, asOf = Date.now(), key = ETF.key) {
  const fund = instrument(key)
  if (!Array.isArray(navHistory) || navHistory.length < 2 || !Array.isArray(dividends)) fail('历史数据缺失')
  const lastDate = navHistory.at(-1).date
  const byDate = new Map()
  const seenDividendDates = new Set()
  for (const dividend of dividends) {
    if (!validDate(dividend.date) || !positive(dividend.amount) || seenDividendDates.has(dividend.date)) fail('分红事件无效或重复')
    seenDividendDates.add(dividend.date)
    if (dividend.date <= lastDate) byDate.set(dividend.date, dividend.amount)
  }
  let value = 100
  let dividendCount = 0
  const points = navHistory.map((row, index) => {
    if (!positive(row.nav) || !Number.isFinite(row.dividend) || row.dividend < 0 || !Number.isFinite(row.time) || (index && row.time <= navHistory[index - 1].time)) fail('净值数据重复或无效')
    const declaredDividend = byDate.get(row.date) ?? 0
    if (Math.abs(declaredDividend - row.dividend) > 1e-8) fail('分红表与除息日净值标注不一致')
    if (row.dividend) { dividendCount += 1; byDate.delete(row.date) }
    if (index === 0 && row.dividend) fail('起点当日分红缺少前日净值')
    // Reinvest the cash into new units at the ex-dividend NAV; do not use additive cumulative NAV.
    if (index) value *= (row.nav + row.dividend) / navHistory[index - 1].nav
    if (!positive(value)) fail('总回报计算溢出')
    return { time: row.time, close: value, open: null, high: null, low: null, volume: null }
  })
  if (byDate.size) fail('除息日单位净值缺失，无法计算再投资')
  return {
    key: fund.key, fundCode: fund.fundCode, name: fund.name,
    baseDate: navHistory[0].date, lastDate, baseValue: 100, latestValue: value,
    totalReturnPercent: (value / 100 - 1) * 100, points, dividendCount,
    sourceName: '天天基金 / 东方财富（单位净值、现金分红）', sourceUrl: dividendUrl(fund),
    asOf, isStale: false, note: totalReturnNote(fund),
  }
}

export function createEtfTotalReturnAdapter({ fetchImpl = fetch, now = Date.now } = {}) {
  const cache = new Map()
  const pending = new Map()
  async function getText(url) {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(TIMEOUT),
      headers: { 'User-Agent': 'Mozilla/5.0 Market Dashboard', Referer: 'https://fund.eastmoney.com/' },
    })
    if (!response.ok) fail(`上游返回 ${response.status}`)
    const contentLength = Number(response.headers.get('content-length'))
    if (contentLength > 2_000_000) fail('上游响应过大')
    const text = await response.text()
    if (text.length > 2_000_000) fail('上游响应过大')
    return text
  }
  async function history(key) {
    const fund = instrument(key)
    const previous = cache.get(key)
    if (previous && now() < previous.expiresAt) return previous
    if (pending.has(key)) return pending.get(key)
    const task = (async () => {
      try {
        const [navText, dividendHtml] = await Promise.all([
          getText(`https://fund.eastmoney.com/pingzhongdata/${fund.fundCode}.js`),
          getText(dividendUrl(fund)),
        ])
        const nav = parseEtfNavHistory(navText, key)
        const result = calculateEtfTotalReturn(nav, parseEtfDividends(dividendHtml, key), now(), key)
        if (result.lastDate > new Date(now() + SHANGHAI_OFFSET).toISOString().slice(0, 10)) fail('净值日期在未来')
        if (previous && result.lastDate < previous.result.lastDate) fail('上游净值日期倒退')
        const value = { nav, result, expiresAt: now() + CACHE_TTL }
        cache.set(key, value)
        return value
      } catch (error) {
        if (!previous) throw error
        const result = { ...previous.result, isStale: true, note: `${totalReturnNote(fund)} 上游刷新失败，保留最近成功获取的数据及原始净值日期。` }
        const value = { ...previous, result, expiresAt: now() + RETRY_TTL }
        cache.set(key, value)
        return value
      } finally { pending.delete(key) }
    })()
    pending.set(key, task)
    return task
  }
  async function fetchTotalReturn(key) { return (await history(key)).result }
  async function fetchNavTrend(key, period = 'MAX') {
    if (!Object.hasOwn(FUND_LINK_INSTRUMENTS, key) || !PERIODS.has(period)) fail('不支持该场外基金或周期')
    const fund = FUND_LINK_INSTRUMENTS[key]
    const { nav, result } = await history(key)
    const latest = nav.at(-1)
    const previous = nav.at(-2)
    let selected = nav
    if (period === '1D' || period === '5D') selected = nav.slice(period === '1D' ? -1 : -5)
    else if (period !== 'MAX') {
      const cutoff = new Date(latest.time * 1000)
      const months = { '1M': 1, '3M': 3, '1Y': 12, '5Y': 60 }[period]
      const wantedDay = cutoff.getUTCDate()
      cutoff.setUTCDate(1)
      cutoff.setUTCMonth(cutoff.getUTCMonth() - months)
      const lastDay = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)).getUTCDate()
      cutoff.setUTCDate(Math.min(wantedDay, lastDay))
      selected = nav.filter((row) => row.time >= cutoff.getTime() / 1000)
    }
    const change = latest.nav - previous.nav
    return {
      ...fund, price: latest.nav, previousClose: previous.nav, change,
      changePercent: change / previous.nav * 100, dayHigh: null, dayLow: null,
      marketTime: timestampFromDate(latest.date), historyStart: nav[0].time, historyEnd: latest.time,
      dataGranularity: '1d', sourceName: '天天基金 / 东方财富（单位净值）',
      sourceUrl: `https://fund.eastmoney.com/${fund.fundCode}.html`, isStale: result.isStale,
      dataNote: `${fund.contract}；单位净值历史自 ${fund.inceptionDate} 成立日起。按交易日公布净值，无盘中报价；日期为原始净值日期。单位净值会扣减现金分红，未计入红利再投资；完整收益可查看旁边的总回报曲线。${result.isStale ? ' 上游刷新失败，保留最近公布净值及原始日期。' : ''}`,
      points: selected.map((row) => ({ time: row.time, close: row.nav, open: null, high: null, low: null, volume: null })),
    }
  }
  return { fetchTotalReturn, fetchNavTrend }
}

function timestampFromDate(date) { return Date.parse(`${date}T00:00:00+08:00`) / 1000 }

const adapter = createEtfTotalReturnAdapter()
export const fetchEtfTotalReturn = adapter.fetchTotalReturn
export const fetchFundNavTrend = adapter.fetchNavTrend
