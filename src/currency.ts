import type { Market } from './types'

export type CurrencyDirection = 'CNYUSD' | 'USDCNY' | 'CNYEUR' | 'EURCNY'

const currencyPairs = {
  USDCNY: { forward: 'USDCNY', inverse: 'CNYUSD', foreign: '美元', currency: 'USD', forwardSymbol: 'USD/CNY', inverseSymbol: 'CNY/USD', nameSuffix: '（在岸）', englishSuffix: ' · Onshore' },
  EURCNY: { forward: 'EURCNY', inverse: 'CNYEUR', foreign: '欧元', currency: 'EUR', forwardSymbol: 'EUR/CNY', inverseSymbol: 'CNY/EUR', nameSuffix: '', englishSuffix: '' },
} as const

export function formatMarketNumber(value: number | null, market: Market, signed = false) {
  if (value == null || !Number.isFinite(value)) return '--'
  const precision = market.precision ?? 2
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
    signDisplay: signed ? 'always' : 'auto',
  }).format(value)
}

export function convertCurrencyMarket(market: Market, direction: CurrencyDirection): Market {
  if (market.key !== 'USDCNY' && market.key !== 'EURCNY') return market
  const pair = currencyPairs[market.key]
  // A direction from another currency pair must never relabel this market.
  if (direction !== pair.forward && direction !== pair.inverse) return market
  if (market.symbol !== pair.forwardSymbol && market.symbol !== pair.inverseSymbol) return market
  const isInverse = direction === pair.inverse
  const metadata = {
    symbol: isInverse ? pair.inverseSymbol : pair.forwardSymbol,
    name: `${isInverse ? `人民币兑${pair.foreign}` : `${pair.foreign}兑人民币`}${pair.nameSuffix}`,
    englishName: `${isInverse ? pair.inverseSymbol : pair.forwardSymbol}${pair.englishSuffix}`,
    unit: isInverse ? `${pair.foreign}/人民币` : `人民币/${pair.foreign}`,
    currency: isInverse ? pair.currency : 'CNY',
    precision: isInverse ? 6 : 4,
  }
  if (market.symbol === metadata.symbol) return { ...market, ...metadata }
  const invert = (value: number | null) => value !== null && Number.isFinite(value) && value > 0 ? 1 / value : null
  const price = invert(market.price)
  const previousClose = invert(market.previousClose)
  const change = price !== null && previousClose !== null ? price - previousClose : null
  return {
    ...market,
    ...metadata,
    price,
    previousClose,
    change,
    changePercent: change !== null && previousClose ? change / previousClose * 100 : null,
    // Taking a reciprocal reverses the ordering of the high and low.
    dayHigh: invert(market.dayLow),
    dayLow: invert(market.dayHigh),
    points: market.points.flatMap((point) => {
      const close = invert(point.close)
      return close === null ? [] : [{
        ...point,
        open: invert(point.open),
        high: invert(point.low),
        low: invert(point.high),
        close,
      }]
    }),
  }
}
