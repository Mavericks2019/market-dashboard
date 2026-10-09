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

const euroMarket = { ...market, key: 'EURCNY', symbol: 'EUR/CNY', name: '欧元兑人民币', englishName: 'EUR/CNY', unit: 'CNY/EUR' }

test('欧元默认以人民币计价，反向重算 OHLC、绝对涨跌和涨跌幅', () => {
  const forward = convertCurrencyMarket(euroMarket, 'EURCNY')
  assert.equal(forward.price, 8)
  assert.equal(forward.symbol, 'EUR/CNY')
  assert.equal(forward.name, '欧元兑人民币')
  assert.equal(forward.currency, 'CNY')
  assert.equal(forward.precision, 4)
  assert.equal(forward.unit, '人民币/欧元')
  assert.equal(forward.points, euroMarket.points)

  const inverse = convertCurrencyMarket(euroMarket, 'CNYEUR')
  assert.equal(inverse.symbol, 'CNY/EUR')
  assert.equal(inverse.name, '人民币兑欧元')
  assert.equal(inverse.englishName, 'CNY/EUR')
  assert.equal(inverse.currency, 'EUR')
  assert.equal(inverse.unit, '欧元/人民币')
  assert.equal(inverse.precision, 6)
  assert.equal(inverse.price, 0.125)
  assert.equal(inverse.previousClose, 0.25)
  assert.equal(inverse.change, -0.125)
  assert.equal(inverse.changePercent, -50)
  assert.equal(inverse.dayHigh, 0.2)
  assert.equal(inverse.dayLow, 0.1)
  assert.deepEqual(inverse.points[0], { time: 1, open: 1 / 6, high: 0.2, low: 0.1, close: 0.125, volume: null })
  assert.equal(euroMarket.symbol, 'EUR/CNY')
})

test('两种货币方向独立，未知币对和非汇率市场保持原样', () => {
  assert.equal(convertCurrencyMarket(euroMarket, 'CNYUSD'), euroMarket)
  assert.equal(convertCurrencyMarket(euroMarket, 'USDCNY'), euroMarket)
  assert.equal(convertCurrencyMarket(market, 'CNYEUR'), market)
  assert.equal(convertCurrencyMarket(market, 'EURCNY'), market)
  const incorrectSymbol = { ...euroMarket, symbol: 'USD/CNY' }
  assert.equal(convertCurrencyMarket(incorrectSymbol, 'CNYEUR'), incorrectSymbol)
  const unrelated = { ...euroMarket, key: 'CFETS' }
  assert.equal(convertCurrencyMarket(unrelated, 'CNYEUR'), unrelated)
})

test('已经转换的欧元币对不会重复取倒数，并可以切回原始方向', () => {
  const inverse = convertCurrencyMarket(euroMarket, 'CNYEUR')
  const sameDirection = convertCurrencyMarket(inverse, 'CNYEUR')
  assert.equal(sameDirection.price, 0.125)
  assert.equal(sameDirection.points, inverse.points)
  const forward = convertCurrencyMarket(inverse, 'EURCNY')
  assert.equal(forward.price, 8)
  assert.equal(forward.previousClose, 4)
  assert.equal(forward.changePercent, 100)
  assert.equal(forward.symbol, 'EUR/CNY')
  assert.equal(forward.precision, 4)
  assert.equal(forward.currency, 'CNY')
})

test('欧元的无效价格和 OHLC 保留缺失状态，过滤无效历史收盘', () => {
  const inverse = convertCurrencyMarket({ ...euroMarket, price: -1, previousClose: Infinity,
    dayHigh: 0, dayLow: NaN,
    points: [{ time: 1, open: 0, high: Infinity, low: -1, close: 8, volume: null },
      { time: 2, close: 0 }, { time: 3, close: NaN }, { time: 4, close: Infinity }, { time: 5, close: -2 }] }, 'CNYEUR')
  assert.equal(inverse.price, null)
  assert.equal(inverse.previousClose, null)
  assert.equal(inverse.change, null)
  assert.equal(inverse.changePercent, null)
  assert.equal(inverse.dayHigh, null)
  assert.equal(inverse.dayLow, null)
  assert.deepEqual(inverse.points, [{ time: 1, open: null, high: null, low: null, close: 0.125, volume: null }])
})
