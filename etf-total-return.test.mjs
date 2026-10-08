import test from 'node:test'
import assert from 'node:assert/strict'
import { FUND_LINK_INSTRUMENTS, calculateEtfTotalReturn, createEtfTotalReturnAdapter, parseEtfDividends, parseEtfNavHistory } from './etf-total-return.mjs'

const dates = ['2020-01-17', '2020-01-20', '2020-01-21', '2020-01-22']
const timestamp = (date) => Date.parse(`${date}T00:00:00+08:00`)
const net = [
  { x: timestamp(dates[0]), y: 1, unitMoney: '' },
  { x: timestamp(dates[1]), y: 0.9, unitMoney: '分红：每份派现金0.1元' },
  { x: timestamp(dates[2]), y: 0.99, unitMoney: '' },
  { x: timestamp(dates[3]), y: 0.94, unitMoney: '分红：每份派现金0.05元' },
]
const cumulative = net.map((point, index) => [point.x, point.y + (index === 0 ? 0 : index === 3 ? 0.15 : 0.1)])
function source(nav = net, accumulated = cumulative) {
  return `var fS_code = "515450"; var fS_name = "红利低波50ETF南方"; var Data_netWorthTrend = ${JSON.stringify(nav)}; var Data_ACWorthTrend = ${JSON.stringify(accumulated)};`
}
const dividends = [{ date: dates[1], amount: 0.1 }, { date: dates[3], amount: 0.05 }]
function dividendHtml(events = dividends) {
  return `<title>红利低波50ETF南方(515450)基金分红送配 _ 天天基金网</title><table><tr><th>权益登记日</th><th>除息日</th><th>每10份分红</th></tr>${events.map((event) => `<tr><td>2020年</td><td>${event.date}</td><td>${event.date}</td><td>每10份派现金${event.amount * 10}元</td><td>${event.date}</td></tr>`).join('')}</table><table><tr><th>拆分折算日</th><th>拆分折算比例</th></tr><tr><td>暂无拆分信息!</td></tr></table>`
}

test('reinvested cash dividends do not create an ex-dividend loss and compound after reinvestment', () => {
  const result = calculateEtfTotalReturn(parseEtfNavHistory(source()), parseEtfDividends(dividendHtml()), 123)
  assert.deepEqual(result.points.map((point) => Math.round(point.close)), [100, 100, 110, 110])
  assert.equal(result.dividendCount, 2)
  assert.equal(result.baseDate, dates[0])
  assert.equal(result.lastDate, dates[3])
  assert.ok(Math.abs(result.totalReturnPercent - 10) < 1e-10)
  assert.notEqual(result.latestValue, cumulative.at(-1)[1] * 100)
  assert.equal(result.asOf, 123)
  assert.equal(new Date(result.points[0].time * 1000).toISOString().slice(0, 10), dates[0])
  assert.match(result.note, /理论总回报/)
  assert.match(result.note, /基金运作费用已反映在净值中/)
})

test('safe parsing rejects code identity changes, executable expressions and duplicate assignments', () => {
  assert.throws(() => parseEtfNavHistory(source().replace('"515450"', '"510050"')), /身份/)
  assert.throws(() => parseEtfNavHistory(source().replace('红利低波50ETF南方', '另一只基金')), /身份/)
  assert.throws(() => parseEtfNavHistory(source().replace('var Data_netWorthTrend = ', 'var Data_netWorthTrend = globalThis.run(')), /JSON/)
  assert.throws(() => parseEtfNavHistory(`${source()} var fS_code="515450";`), /重复/)
  assert.throws(() => parseEtfNavHistory(source().replace('"515450";', '"515450" + doSomething();')), /JSON/)
})

test('missing dividends, duplicate dates, cumulative date mismatches and unknown corporate actions fail closed', () => {
  const missingCash = structuredClone(net)
  missingCash[1].unitMoney = ''
  assert.throws(() => parseEtfNavHistory(source(missingCash)), /漏计/)
  assert.throws(() => parseEtfNavHistory(source([net[0], net[1], net[1], net[3]])), /重复/)
  assert.throws(() => parseEtfNavHistory(source(net, cumulative.slice(1))), /缺失/)
  const wrongDate = structuredClone(cumulative)
  wrongDate[1][0] = wrongDate[0][0]
  assert.throws(() => parseEtfNavHistory(source(net, wrongDate)), /错位/)
  const split = structuredClone(net)
  split[1].unitMoney = '拆分：每份折算2份'
  assert.throws(() => parseEtfNavHistory(source(split)), /拆分/)
  assert.throws(() => parseEtfNavHistory(source(net.slice(1), cumulative.slice(1))), /漏计|成立日/)
})

test('dividend table uses ex-date and converts every ten units, rejects duplicates and splits', () => {
  assert.deepEqual(parseEtfDividends(dividendHtml()), dividends)
  assert.throws(() => parseEtfDividends(dividendHtml([dividends[0], dividends[0]])), /重复/)
  assert.throws(() => parseEtfDividends(dividendHtml().replace('暂无拆分信息!', '1:2')), /拆分/)
  assert.throws(() => parseEtfDividends(dividendHtml().replace('(515450)', '(510050)')), /身份/)
  assert.throws(() => parseEtfDividends(dividendHtml().replace('每10份派现金1元', '每份派现金1元')), /格式/)
})

test('independent dividend table detects omitted or mismatched events and missing ex-date NAV', () => {
  const nav = parseEtfNavHistory(source())
  assert.throws(() => calculateEtfTotalReturn(nav, dividends.slice(1)), /不一致/)
  assert.throws(() => calculateEtfTotalReturn(nav, [{ ...dividends[0], amount: 0.2 }, dividends[1]]), /不一致/)
  assert.throws(() => calculateEtfTotalReturn(nav.filter((row) => row.date !== dates[1]), dividends), /除息日单位净值缺失/)
  assert.throws(() => calculateEtfTotalReturn(nav, [...dividends, dividends[0]]), /重复/)
  // An announced future distribution must not change the published NAV history yet.
  assert.equal(calculateEtfTotalReturn(nav, [...dividends, { date: '2020-01-30', amount: 0.1 }]).dividendCount, 2)
  assert.throws(() => calculateEtfTotalReturn(nav, [...dividends, { date: '2020-01-30', amount: 0.1 }, { date: '2020-01-30', amount: 0.1 }]), /重复/)
})

test('adapter coalesces requests, caches, preserves dates and marks fallback stale after upstream failure', async () => {
  let calls = 0
  let clock = Date.parse('2020-01-23T00:00:00Z')
  let failure = false
  const adapter = createEtfTotalReturnAdapter({ now: () => clock, fetchImpl: async (url) => {
    calls += 1
    if (failure) throw new Error('network offline')
    return new Response(url.includes('pingzhongdata') ? source() : dividendHtml())
  } })
  const [first, second] = await Promise.all([adapter.fetchTotalReturn('NF_DIV_LV50'), adapter.fetchTotalReturn('NF_DIV_LV50')])
  assert.equal(calls, 2)
  assert.deepEqual(first, second)
  assert.equal(first.isStale, false)
  await adapter.fetchTotalReturn('NF_DIV_LV50')
  assert.equal(calls, 2)
  failure = true
  clock += 61 * 60_000
  const stale = await adapter.fetchTotalReturn('NF_DIV_LV50')
  assert.equal(stale.isStale, true)
  assert.equal(stale.asOf, first.asOf)
  assert.equal(stale.lastDate, first.lastDate)
  assert.deepEqual(stale.points, first.points)
  assert.match(stale.note, /刷新失败/)
  failure = false
  clock += 61_000
  assert.equal((await adapter.fetchTotalReturn('NF_DIV_LV50')).isStale, false)
  await assert.rejects(adapter.fetchTotalReturn('AAPL'), /不支持/)
})

test('adapter refuses to produce a substitute curve if no validated data has been cached', async () => {
  const adapter = createEtfTotalReturnAdapter({ fetchImpl: async () => new Response('unavailable', { status: 503 }) })
  await assert.rejects(adapter.fetchTotalReturn('NF_DIV_LV50'), /503/)
})

const feederKey = 'NF_DIV_LV50_A'
const feederDates = ['2020-01-21', '2020-09-30', '2021-09-30', '2025-09-29', '2025-09-30', '2026-06-29', '2026-06-30', '2026-08-28', '2026-08-31', '2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30']
const feederNet = feederDates.map((date, index) => ({
  x: timestamp(date), y: index === 0 ? 1 : index === feederDates.length - 2 ? 1.02 : 1.04,
  unitMoney: index === feederDates.length - 2 ? '分红：每份派现金0.02元' : '',
}))
const feederCumulative = feederNet.map((point, index) => [point.x, point.y + (index >= feederDates.length - 2 ? 0.02 : 0)])
const feederSource = source(feederNet, feederCumulative).replace('"515450"', '"008163"').replace('"红利低波50ETF南方"', '"南方标普红利低波50ETF联接A"')
const feederHtml = dividendHtml([{ date: '2026-09-29', amount: 0.02 }]).replace('红利低波50ETF南方(515450)', '南方标普红利低波50ETF联接A(008163)')

test('feeder A validates its own share class, inception and dividend history instead of using the ETF', () => {
  const nav = parseEtfNavHistory(feederSource, feederKey)
  const events = parseEtfDividends(feederHtml, feederKey)
  const result = calculateEtfTotalReturn(nav, events, 123, feederKey)
  assert.equal(result.fundCode, '008163')
  assert.equal(result.baseDate, '2020-01-21')
  assert.equal(result.dividendCount, 1)
  assert.match(result.note, /可选择现金分红或红利再投资/)
  assert.doesNotMatch(result.note, /此ETF实际派发现金/)
  assert.match(result.sourceUrl, /008163/)
  assert.throws(() => parseEtfNavHistory(source(), feederKey), /身份/)
  assert.throws(() => parseEtfNavHistory(feederSource), /身份/)
  assert.throws(() => parseEtfNavHistory(feederSource.replace('008163', '008164'), feederKey), /身份/)
  assert.throws(() => parseEtfDividends(dividendHtml(), feederKey), /身份/)
  assert.throws(() => parseEtfDividends(feederHtml), /身份/)
})

test('feeder NAV and total return share validated history while ETF caches and refresh failures stay isolated', async () => {
  const calls = []
  let clock = Date.parse('2026-10-08T00:00:00Z')
  let feederFailure = false
  const adapter = createEtfTotalReturnAdapter({ now: () => clock, fetchImpl: async (url) => {
    calls.push(url)
    const feeder = url.includes('008163')
    if (feeder && feederFailure) throw new Error('feeder offline')
    return new Response(url.includes('pingzhongdata') ? feeder ? feederSource : source() : feeder ? feederHtml : dividendHtml())
  } })
  const [nav, total, etf] = await Promise.all([
    adapter.fetchNavTrend(feederKey), adapter.fetchTotalReturn(feederKey), adapter.fetchTotalReturn('NF_DIV_LV50'),
  ])
  assert.equal(calls.length, 4)
  assert.equal(calls.filter((url) => url.includes('008163')).length, 2)
  assert.equal(nav.symbol, '008163')
  assert.equal(nav.price, 1.04)
  assert.equal(total.dividendCount, 1)
  assert.equal(etf.dividendCount, 2)
  assert.notEqual(nav.points.at(-1).close, total.points.at(-1).close)
  assert.equal(nav.isStale, false)
  feederFailure = true
  clock += 61 * 60_000
  const [stale, fresh] = await Promise.all([adapter.fetchNavTrend(feederKey), adapter.fetchTotalReturn('NF_DIV_LV50')])
  assert.equal(stale.isStale, true)
  assert.equal(fresh.isStale, false)
  assert.equal(stale.marketTime, nav.marketTime)
  assert.equal(stale.price, nav.price)
  assert.match(stale.dataNote, /刷新失败/)
  assert.equal((await adapter.fetchTotalReturn(feederKey)).asOf, total.asOf)
})

test('feeder NAV exposes actual daily dates and unit NAV, with full inception history and calendar period slicing', async () => {
  const adapter = createEtfTotalReturnAdapter({ now: () => Date.parse('2026-10-08T00:00:00Z'), fetchImpl: async (url) => new Response(url.includes('pingzhongdata') ? feederSource : feederHtml) })
  const [max, day, week, month, quarter, year, fiveYears] = await Promise.all(['MAX', '1D', '5D', '1M', '3M', '1Y', '5Y'].map((period) => adapter.fetchNavTrend(feederKey, period)))
  const firstDate = (market) => new Date(market.points[0].time * 1000).toISOString().slice(0, 10)
  assert.equal(firstDate(max), '2020-01-21')
  assert.equal(day.points.length, 1)
  assert.equal(week.points.length, 5)
  assert.equal(firstDate(month), '2026-08-31')
  assert.equal(firstDate(quarter), '2026-06-30')
  assert.equal(firstDate(year), '2025-09-30')
  assert.equal(firstDate(fiveYears), '2021-09-30')
  assert.equal(max.historyStart, day.historyStart)
  assert.equal(max.dataGranularity, '1d')
  assert.equal(max.frequency, '每日公布净值')
  assert.equal(max.kind, 'fund')
  assert.equal(max.price, 1.04)
  assert.equal(max.previousClose, 1.02)
  assert.equal(max.marketTime * 1000, timestamp('2026-09-30'))
  assert.equal(max.dayHigh, null)
  assert.equal(max.dayLow, null)
  assert.ok(max.points.every((point) => point.open === null && point.high === null && point.low === null && point.volume === null))
  assert.match(max.dataNote, /无盘中报价/)
  assert.equal(FUND_LINK_INSTRUMENTS[feederKey].precision, 4)
  await assert.rejects(adapter.fetchNavTrend('NF_DIV_LV50'), /不支持/)
  await assert.rejects(adapter.fetchNavTrend(feederKey, 'BAD'), /不支持/)
})
