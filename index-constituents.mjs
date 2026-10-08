import { read, utils } from '@e965/xlsx'

const DAY = 86_400_000
const CACHE_TTL = 6 * 60 * 60_000
const RETRY_TTL = 60_000
const ALIASES = { NQ: 'NDX', ES: 'SPX', YM: 'DJI' }
const CSI_ROOT = 'https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/file/autofile/cons/'

export const INDEX_CONSTITUENTS = {
  HXC: { name: '纳斯达克中国金龙指数', symbol: 'HXC', provider: 'nasdaq', id: 'HXC', min: 20, max: 300 },
  NDX: { name: '纳斯达克100指数', symbol: 'NDX', provider: 'nasdaq', id: 'NDX', min: 90, max: 110 },
  IXIC: { name: '纳斯达克综合指数', symbol: 'IXIC', provider: 'nasdaq', id: 'COMP', min: 1000, max: 7000 },
  SPX: { name: '标普500指数', symbol: 'SPX', provider: 'sp500', min: 500, max: 510 },
  DJI: { name: '道琼斯工业平均指数', symbol: 'DJI', provider: 'stockanalysis', count: 30 },
  FTSE: { name: '富时100指数', symbol: 'FTSE', provider: 'hl', count: 100 },
  DAX: { name: '德国DAX指数', symbol: 'DAX', provider: 'onvista', count: 40 },
  KOSPI: { name: '韩国综合指数', symbol: 'KOSPI', provider: 'krx', min: 600, max: 1500 },
  NIKKEI: { name: '日经225指数', symbol: 'NIKKEI', provider: 'nikkei', count: 225 },
  SSE: { name: '上证指数', symbol: '000001', provider: 'csi', min: 1500, max: 4000 },
  SZSE: { name: '深证成指', symbol: '399001', provider: 'cni', count: 500 },
  ChiNext: { name: '创业板指', symbol: '399006', provider: 'cni', count: 100 },
  CSI_DIV: { name: '中证红利指数', symbol: '000922', provider: 'csi', count: 100 },
  CSI_DIV_LV: { name: '中证红利低波动指数', symbol: 'H30269', provider: 'csi', count: 50 },
  CSI_DIV_LV100: { name: '中证红利低波动100指数', symbol: '930955', provider: 'csi', count: 100 },
  SSE_DIV: { name: '上证红利指数', symbol: '000015', provider: 'csi', count: 50 },
  HSTECH: { name: '恒生科技指数', symbol: 'HSTECH', provider: 'hsi', count: 30 },
}

function fail(message) { throw new Error(`指数成分：${message}`) }
function text(value) { return typeof value === 'string' ? value.trim() : '' }
function date(value) {
  const raw = String(value ?? '')
  const day = /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}` : raw.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) fail('成分日期无效')
  return day
}
function complete(rows, expected, config) {
  if (!Array.isArray(rows) || !rows.length || !Number.isSafeInteger(expected) || rows.length !== expected) fail('成分数量不完整')
  if (config.count && rows.length !== config.count) fail('成分数量与指数规则不符')
  if ((config.min && rows.length < config.min) || (config.max && rows.length > config.max)) fail('成分数量异常')
  if (rows.some((row) => !row.name || !row.symbol || !row.key) || new Set(rows.map((row) => row.key)).size !== rows.length) fail('成分无效或重复')
  return rows
}
function chinaRow(symbol, name, englishName = '', exchange = '') {
  if (!/^\d{6}$/.test(symbol)) fail('中国股票代码无效')
  const suffix = /上海|Shanghai/i.test(exchange) ? 'SH' : /深圳|Shenzhen/i.test(exchange) ? 'SZ' : /北京|Beijing/i.test(exchange) ? 'BJ' : null
  return { key: `CN:${symbol}`, symbol, name: text(name), englishName: text(englishName), market: 'CN', exchange, ...(suffix ? { secucode: `${symbol}.${suffix}` } : {}) }
}

export function parseNasdaqConstituents(payload, config) {
  if (!Array.isArray(payload?.aaData)) fail('Nasdaq成分格式异常')
  const rows = payload.aaData.map((row) => {
    const symbol = text(row?.Symbol)
    if (!/^[A-Z0-9.$^/-]{1,24}$/.test(symbol)) fail('Nasdaq成分代码无效')
    // Preserve temporary corporate-action symbols and share classes. They are
    // genuine constituents even when no valuation feed recognizes their code.
    return { key: `US:${symbol}`, symbol, name: text(row.Name) || symbol, englishName: text(row.Name), market: 'US' }
  })
  if (payload.iTotalDisplayRecords !== undefined && payload.iTotalDisplayRecords !== payload.iTotalRecords) fail('Nasdaq返回了部分成分')
  return complete(rows, payload.iTotalRecords, config)
}

export function parseCsiConstituents(buffer, config) {
  const book = read(buffer, { type: 'buffer', cellDates: false })
  const table = utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, raw: false, defval: '' })
  const header = table.shift()
  if (!header || !String(header[0]).includes('日期') || !String(header[1]).includes('指数代码') || !/成[分份]券代码/.test(header[4]) || !String(header[7]).includes('交易所')) fail('中证成分文件表头异常')
  const dates = new Set()
  const rows = table.filter((row) => row.some((cell) => String(cell).trim())).map((row) => {
    const code = String(row[1]).padStart(6, '0')
    if (code !== config.symbol) fail('中证成分文件指数代码不匹配')
    dates.add(date(row[0]))
    return chinaRow(String(row[4]).padStart(6, '0'), row[5], row[6], row[7])
  })
  if (dates.size !== 1) fail('中证成分文件日期不一致')
  return { rows: complete(rows, rows.length, config), holdingsDate: [...dates][0] }
}

export function parseCniConstituents(payload, config) {
  if (payload?.code !== 200 || !Array.isArray(payload.data?.rows)) fail('国证成分格式异常')
  const dates = new Set()
  const rows = payload.data.rows.map((row) => {
    if (row.indexcode && row.indexcode !== config.symbol) fail('国证成分指数代码不匹配')
    dates.add(date(row.dateStr))
    return chinaRow(String(row.seccode).padStart(6, '0'), row.secname, '', '深圳证券交易所')
  })
  if (dates.size !== 1 || (payload.total !== undefined && payload.total !== payload.data.total)) fail('国证成分日期或总数不一致')
  return { rows: complete(rows, payload.data.total, config), holdingsDate: [...dates][0] }
}

export function parseHsiConstituents(payload, config, englishPayload = null) {
  function series(body) {
    const found = body?.indexSeriesList?.find((item) => item.seriesCode === 'hstech')
    if (!found || found.indexList?.length !== 1 || !Array.isArray(found.indexList[0].constituentContent)) fail('恒生科技成分身份或格式异常')
    return found
  }
  const chinese = series(payload)
  const index = chinese.indexList[0]
  const english = englishPayload ? series(englishPayload) : null
  const enNames = new Map(english?.indexList[0].constituentContent.map((row) => [String(row.code).padStart(5, '0'), text(row.constituentName)]) ?? [])
  const rows = index.constituentContent.map((row) => {
    if (!/^\d{1,5}$/.test(String(row.code)) || row.isDummy !== 'N') fail('恒生成分包含无效或临时记录')
    const symbol = String(row.code).padStart(5, '0')
    return { key: `HK:${symbol}`, symbol, name: text(row.constituentName), englishName: enNames.get(symbol) ?? '', market: 'HK', exchange: '香港交易所', secucode: `${symbol}.HK` }
  })
  if (english && (date(english.constituentsDate) !== date(chinese.constituentsDate) || english.indexList[0].constituentsCount !== index.constituentsCount || enNames.size !== rows.length || rows.some((row) => !enNames.has(row.symbol)))) fail('恒生中英文成分不一致')
  return { rows: complete(rows, index.constituentsCount, config), holdingsDate: date(chinese.constituentsDate) }
}

function csvTable(body) {
  const book = read(body, { type: 'buffer', raw: true })
  return utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, raw: true, defval: '' })
}

export function parseNikkeiConstituents(buffer, config) {
  const table = csvTable(buffer)
  const header = table.shift()
  if (header?.[0] !== 'Date of Data' || header[1] !== 'Code' || header[2] !== 'Company Name') fail('日经成分文件表头异常')
  const dates = new Set()
  const rows = table.filter((row) => String(row[1] ?? '').trim()).map((row) => {
    dates.add(date(String(row[0]).replaceAll('/', '-')))
    const symbol = String(row[1])
    if (!/^[0-9][0-9A-Z]{3}$/.test(symbol)) fail('日经成分股票代码无效')
    return { key: `JP:${symbol}`, symbol, name: text(row[2]), englishName: text(row[2]), market: 'JP', exchange: 'Tokyo Stock Exchange' }
  })
  if (dates.size !== 1) fail('日经成分日期不一致')
  return { rows: complete(rows, config.count, config), holdingsDate: [...dates][0] }
}

export function parseSp500Constituents(buffer, sectorBuffer, config) {
  const table = csvTable(buffer)
  const header = table.shift()
  const sectors = csvTable(sectorBuffer)
  if (header?.[0] !== 'Symbol' || header[1] !== 'Security' || sectors.shift()?.join(',') !== 'sector,count') fail('标普成分目录表头异常')
  const expected = sectors.reduce((sum, row) => sum + Number(row[1]), 0)
  const rows = table.filter((row) => row.some((cell) => String(cell).trim())).map((row) => {
    const symbol = text(row[0])
    if (!/^[A-Z0-9.-]{1,16}$/.test(symbol)) fail('标普成分代码无效')
    return { key: `US:${symbol}`, symbol, name: text(row[1]), englishName: text(row[1]), market: 'US' }
  })
  return { rows: complete(rows, expected, config), holdingsDate: null }
}

function htmlText(value) {
  return value.replace(/<[^>]*>/g, ' ').replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => String.fromCodePoint(n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').trim()
}

export function parseDowConstituents(body, config) {
  const html = body.toString('utf8')
  if (!html.includes('Dow Jones Industrial Average Stocks List') || /derived from the holdings/i.test(html)) fail('道指成分页面身份异常')
  const table = html.match(/<table\b[^>]*\bid="main-table"[^>]*>([\s\S]*?)<\/table>/)?.[1]
  if (!table || !table.includes('Company Name') || !table.includes('Symbol')) fail('道指成分表缺失')
  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].filter((match) => match[1].includes('<td')).map((match) => {
    const cells = [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => htmlText(cell[1]))
    const symbol = cells[1]
    if (!/^[A-Z0-9.-]{1,16}$/.test(symbol)) fail('道指成分代码无效')
    return { key: `US:${symbol}`, symbol, name: cells[2], englishName: cells[2], market: 'US' }
  })
  const expected = Number(htmlText(html.slice(0, html.indexOf('<table'))).match(/Total Stocks\s+(\d+)\b/)?.[1])
  return { rows: complete(rows, expected, config), holdingsDate: null }
}

export function parseFtseConstituents(body, config) {
  const html = body.toString('utf8')
  if (!/<title>FTSE 100 Market overview \| Hargreaves Lansdown<\/title>/.test(html)) fail('富时100成分页面身份异常')
  const rows = [...html.matchAll(/<tr\s+id="ls-row-[^"]+"[^>]*>([\s\S]*?)<\/tr>/g)].map((match) => {
    const symbol = htmlText(match[1].match(/<td>([\s\S]*?)<\/td>/)?.[1] ?? '')
    const name = htmlText(match[1].match(/data-s-name="([^"]+)"/)?.[1] ?? '')
    if (!/^[A-Z0-9.]{1,12}$/.test(symbol)) fail('富时100股票代码无效')
    return { key: `GB:${symbol}`, symbol, name, englishName: name, market: 'GB', exchange: 'London Stock Exchange' }
  })
  return { rows: complete(rows, config.count, config), holdingsDate: null }
}

export function parseDaxConstituents(payload, config) {
  if (!Array.isArray(payload?.list)) fail('DAX成分格式异常')
  const rows = payload.list.map((item) => {
    const stock = item.instrument
    const symbol = text(stock?.homeSymbol) || text(stock?.symbol)
    if (stock?.entityType !== 'STOCK' || !/^[A-Z0-9.]{1,12}$/.test(symbol) || item.quote?.market?.nameExchange !== 'Xetra') fail('DAX股票代码或交易所异常')
    return { key: `DE:${symbol}`, symbol, name: text(stock.name), englishName: text(stock.name), market: 'DE', exchange: 'Xetra' }
  })
  return { rows: complete(rows, payload.total, config), holdingsDate: null }
}

export function parseKrxConstituents(payload, comparison, tradingDate, config) {
  if (!Array.isArray(payload?.output) || !Array.isArray(comparison?.output)) fail('KRX成分格式异常')
  function code(value) {
    const raw = String(value ?? '')
    if (!/^[0-9][0-9A-Z]{0,5}$/.test(raw) || /^0+$/.test(raw)) fail('KRX成分股票代码无效')
    return raw.padStart(6, '0')
  }
  const rows = payload.output.map((stock) => {
    const symbol = code(stock.isu_cd)
    return { key: `KR:${symbol}`, symbol, name: text(stock.isu_nm), englishName: text(stock.isu_nm), market: 'KR', exchange: 'Korea Exchange' }
  })
  const codes = new Set(comparison.output.map((stock) => code(stock.isu_cd)))
  if (codes.size !== comparison.output.length || rows.some((stock) => !codes.has(stock.symbol))) fail('KRX两个完整成分目录不一致')
  return { rows: complete(rows, comparison.output.length, config), holdingsDate: date(tradingDate) }
}

export function createIndexConstituentsAdapter({ fetchImpl = fetch, now = Date.now } = {}) {
  const cache = new Map()
  const pending = new Map()
  const registry = new Map()
  async function request(url, options = {}, binary = false, timeoutMs = 12_000) {
    const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'Mozilla/5.0 Market Dashboard', ...options.headers } })
    if (!response.ok) fail(`上游返回 ${response.status}`)
    if (Number(response.headers.get('content-length')) > 12_000_000) fail('成分文件过大')
    const body = Buffer.from(await response.arrayBuffer())
    if (body.length > 12_000_000) fail('成分文件过大')
    return binary ? body : JSON.parse(body.toString('utf8'))
  }
  async function krxData(bld, parameters = {}) {
    // Public index pages generate this request token for every data query; it
    // is not a login credential or a user authentication challenge.
    const tokenUrl = `https://eindex.krx.co.kr/contents/COM/GenerateOTP.jspx?${new URLSearchParams({ name: 'form', bld })}`
    const code = (await request(tokenUrl, {}, true)).toString('utf8').trim()
    if (!/^[A-Za-z0-9+/=_-]{16,2048}$/.test(code)) fail('KRX公开数据请求令牌无效')
    return request('https://eindex.krx.co.kr/contents/IDXE/99/IDXE99000001.jspx', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...parameters, code }),
    }, false, 25_000)
  }
  async function retrieve(config) {
    if (config.provider === 'nasdaq') {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now()))
      for (let offset = 0; offset < 8; offset += 1) {
        const tradeDate = new Date(Date.parse(`${today}T00:00:00Z`) - offset * DAY).toISOString().slice(0, 10)
        const payload = await request('https://indexes.nasdaqomx.com/Index/WeightingData', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ id: config.id, tradeDate, timeOfDay: 'SOD' }),
        })
        if (payload?.iTotalRecords === 0 && Array.isArray(payload.aaData) && !payload.aaData.length) continue
        return { rows: parseNasdaqConstituents(payload, config), holdingsDate: tradeDate, sourceName: 'Nasdaq Global Index Watch（官方成分）', sourceUrl: `https://indexes.nasdaqomx.com/Index/Weighting/${config.id}`, note: '完整成分名单按Nasdaq日初口径；临时公司行动代码保留，无法匹配估值的项目显示暂无。' }
      }
      fail('Nasdaq最近八日均未公布成分')
    }
    if (config.provider === 'csi') {
      const sourceUrl = `${CSI_ROOT}${config.symbol}cons.xls`
      return { ...parseCsiConstituents(await request(sourceUrl, {}, true), config), sourceName: '中证指数（官方成分目录）', sourceUrl, note: '完整成分取自中证指数发布的成分券目录，日期为文件原始日期。' }
    }
    if (config.provider === 'cni') {
      const month = new Date(now() + 8 * 3600_000).toISOString().slice(0, 7)
      const url = `https://www.cnindex.com.cn/sample-detail/detail?${new URLSearchParams({ indexcode: config.symbol, dateStr: month, pageNum: '1', rows: '1000', isFirstCall: '1' })}`
      return { ...parseCniConstituents(await request(url), config), sourceName: '国证指数（官方样本详情）', sourceUrl: `https://www.cnindex.com.cn/module/index-detail.html?indexCode=${config.symbol}`, note: '完整样本名单按国证指数最新公布的样本日期展示。' }
    }
    if (config.provider === 'hsi') {
      const base = 'https://origin-www.hsi.com.hk/data/'
      const [chinese, english] = await Promise.all([request(`${base}schi/rt/index-series/hstech/constituents.do`), request(`${base}eng/rt/index-series/hstech/constituents.do`).catch(() => null)])
      return { ...parseHsiConstituents(chinese, config, english), sourceName: '恒生指数公司（官方成分股）', sourceUrl: 'https://origin-www.hsi.com.hk/schi/indexes/all-indexes/hstech', note: '完整成分来自恒生指数公司，港股代码补足五位以区分不同市场。' }
    }
    if (config.provider === 'nikkei') {
      const sourceUrl = 'https://indexes.nikkei.co.jp/nkave/archives/file/nikkei_225_price_adjustment_factor_en.csv'
      return { ...parseNikkeiConstituents(await request(sourceUrl, {}, true), config), sourceName: 'Nikkei Indexes（官方成分文件）', sourceUrl, note: '完整225只成分取自日经官方价格调整系数文件，日期为文件公布日期。' }
    }
    if (config.provider === 'stockanalysis') {
      const sourceUrl = 'https://stockanalysis.com/list/dow-jones-stocks/'
      return { ...parseDowConstituents(await request(sourceUrl, {}, true), config), sourceName: 'Stock Analysis（道指成分目录）', sourceUrl, note: '第三方公开完整成分名单；页面未公布成分生效日期，更新时间为本次抓取时间。' }
    }
    if (config.provider === 'sp500') {
      const repo = 'datasets/s-and-p-500-companies'
      const commit = await request(`https://api.github.com/repos/${repo}/commits?path=data/constituents.csv&per_page=1`).catch(() => null)
      const sha = /^[0-9a-f]{40}$/.test(commit?.[0]?.sha ?? '') ? commit[0].sha : 'main'
      const fileDate = commit?.[0]?.commit?.committer?.date ? date(commit[0].commit.committer.date) : null
      const [csv, sectors] = await Promise.all(['constituents.csv', 'sector-counts.csv'].map((file) => request(`https://raw.githubusercontent.com/${repo}/${sha}/data/${file}`, {}, true)))
      return { ...parseSp500Constituents(csv, sectors, config), sourceName: 'DataHub datasets（维基百科成分目录）', sourceUrl: `https://github.com/${repo}/blob/${sha}/data/constituents.csv`, note: `第三方完整指数成分目录，原始来源为维基百科；${fileDate ? `文件最后更新于${fileDate}，` : ''}未提供统一成分生效日期。按不同股票类别分别列出，因此总数可能超过500。`, ...(fileDate ? { fileUpdatedDate: fileDate } : {}) }
    }
    if (config.provider === 'hl') {
      const sourceUrl = 'https://www.hl.co.uk/shares/stock-market-summary/ftse-100'
      return { ...parseFtseConstituents(await request(sourceUrl, {}, true), config), sourceName: 'Hargreaves Lansdown（富时100成分目录）', sourceUrl, note: '英国券商公布的完整100只成分名单；未公布统一成分生效日期，更新时间为本次抓取时间。' }
    }
    if (config.provider === 'onvista') {
      return { ...parseDaxConstituents(await request('https://api.onvista.de/api/v1/indices/20735/constituents?limit=100'), config), sourceName: 'Onvista（DAX成分目录）', sourceUrl: 'https://www.onvista.de/index/Einzelwerte/DAX-Index-20735', note: 'Onvista公布的完整40只DAX成分名单；使用Xetra股票代码，未公布统一成分生效日期。' }
    }
    if (config.provider === 'krx') {
      const calendar = await krxData('/COM/market_date_t')
      const tradingDate = date(calendar?.DS1?.[0]?.max_work_dt)
      const parameters = { ind_tp_cd: '1', idx_ind_cd: '001', idx_id: 'KGG01P', lang: 'en', schdate: tradingDate.replaceAll('-', '') }
      const [members, comparison] = await Promise.all(['07', '01'].map((suffix) => krxData(`/IDXE/05/0502/0502030101/glb0502030101T3_${suffix}`, parameters)))
      return { ...parseKrxConstituents(members, comparison, tradingDate, config), sourceName: '韩国交易所KRX（官方成分目录）', sourceUrl: 'https://eindex.krx.co.kr/contents/GLB/05/0502/0502030101/GLB0502030101T3.jsp?upmidCd=0102&idxCd=1001&idxId=KGG01P', note: '完整成分取自韩国交易所KOSPI目录，按两个完整名单核对代码与总数；日期为官方日历所示查询交易日。保留含字母的新式股票代码。' }
    }
    fail('当前尚无经完整性验证的公开成分源')
  }
  async function canonical(key, force) {
    if (!Object.hasOwn(INDEX_CONSTITUENTS, key)) fail('不支持该指数')
    const config = INDEX_CONSTITUENTS[key]
    const previous = cache.get(key)
    if (pending.has(key)) return pending.get(key)
    if (!force && previous && now() < previous.expiresAt) return previous.value
    const task = Promise.resolve().then(async () => {
      let value
      try {
        const result = await retrieve(config)
        if (Date.parse(result.holdingsDate ?? result.fileUpdatedDate) > now() + DAY) fail('成分日期在未来')
        if (previous?.value.holdingsDate && result.holdingsDate && result.holdingsDate < previous.value.holdingsDate) fail('成分日期倒退')
        if (previous?.value.fileUpdatedDate && result.fileUpdatedDate && result.fileUpdatedDate < previous.value.fileUpdatedDate) fail('成分文件日期倒退')
        const isStale = now() - Date.parse(result.holdingsDate ?? result.fileUpdatedDate) > 45 * DAY
        const fetchedAt = Math.floor(now() / 1000)
        value = { key, indexName: config.name, indexSymbol: config.symbol, ...result, asOf: fetchedAt, fetchedAt, total: result.rows.length, isStale }
        for (const row of value.rows) registry.set(row.key, Object.freeze({ ...row }))
        cache.set(key, { value, expiresAt: now() + CACHE_TTL })
      } catch (reason) {
        const error = reason instanceof Error ? reason.message : '成分数据暂不可用'
        const staleNote = '刷新失败，保留最近成功的完整名单。'
        value = previous?.value.rows.length ? { ...previous.value, isStale: true, reason: error, note: previous.value.note.includes(staleNote) ? previous.value.note : `${previous.value.note} ${staleNote}` }
          : { key, indexName: config.name, indexSymbol: config.symbol, asOf: Math.floor(now() / 1000), fetchedAt: null, holdingsDate: null, total: null, sourceName: '', sourceUrl: '', isStale: false, note: '尚未取得可核验的完整成分名单。', status: 'unavailable', reason: error, rows: [] }
        cache.set(key, { value, expiresAt: now() + RETRY_TTL })
      } finally { pending.delete(key) }
      return value
    })
    pending.set(key, task)
    return task
  }
  async function fetchIndexConstituents(key, { force = false } = {}) {
    const indexKey = ALIASES[key] ?? key
    const result = await canonical(indexKey, force)
    // Request completion, successful retrieval and the source's membership
    // date are separate clocks. A failed refresh never renews fetchedAt.
    return { ...result, asOf: Math.floor(now() / 1000), ...(key === indexKey ? {} : { key, note: `该股指期货对应${result.indexName}的成分股。${result.note}` }) }
  }
  return { fetchIndexConstituents, getConstituent: (key) => registry.get(key) ?? null }
}

const adapter = createIndexConstituentsAdapter()
export const fetchIndexConstituents = adapter.fetchIndexConstituents
export const getConstituent = adapter.getConstituent
