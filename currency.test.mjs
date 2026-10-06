import test from 'node:test'
import assert from 'node:assert/strict'
import { convertCurrencyMarket, formatMarketNumber } from './src/currency.ts'

const market = {
  key: 'USDCNY', symbol: 'USD/CNY', name: '美元兑人民币（在岸）', englishName: 'USD/CNY',
  unit: 'CNY/USD', currency: 'CNY', precision: 4, price: 8, previousClose: 4,
  change: 4, changePercent: 100, dayHigh: 10, dayLow: 5,
  points: [{ time: 1, open: 6, high: 10, low: 5, close: 8, volume: null }],
}

test('人民币方向从倒数价格重算涨幅，并交换区间与 OHLC 高低', () => {
  const inverse = convertCurrencyMarket(market, 'CNYUSD')
  assert.equal(inverse.price, 0.125)
  assert.equal(inverse.previousClose, 0.25)
  assert.equal(inverse.change, -0.125)
  assert.equal(inverse.changePercent, -50)
  assert.equal(inverse.dayHigh, 0.2)
  assert.equal(inverse.dayLow, 0.1)
  assert.deepEqual(inverse.points[0], { time: 1, open: 1 / 6, high: 0.2, low: 0.1, close: 0.125, volume: null })
  assert.equal(market.price, 8)
  assert.equal(convertCurrencyMarket(market, 'USDCNY').price, 8)
})

test('无效报价不能生成 Infinity，微小汇率波动保留精度', () => {
  const inverse = convertCurrencyMarket({ ...market, price: 0, previousClose: null,
    points: [...market.points, { time: 2, close: 0 }, { time: 3, close: NaN }] }, 'CNYUSD')
  assert.equal(inverse.price, null)
  assert.equal(inverse.changePercent, null)
  assert.equal(inverse.points.length, 1)
  assert.equal(formatMarketNumber(0.000016, inverse, true), '+0.000016')
  assert.equal(formatMarketNumber(7.1234, market), '7.1234')
})
