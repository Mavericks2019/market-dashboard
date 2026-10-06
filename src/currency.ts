import type { Market } from './types'

export type CurrencyDirection = 'CNYUSD' | 'USDCNY'

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
  if (market.key !== 'USDCNY') return market
  if (direction === 'USDCNY') return { ...market, unit: '人民币/美元' }
  const invert = (value: number | null) => value !== null && Number.isFinite(value) && value > 0 ? 1 / value : null
  const price = invert(market.price)
  const previousClose = invert(market.previousClose)
  const change = price !== null && previousClose !== null ? price - previousClose : null
  return {
    ...market,
    symbol: 'CNY/USD',
    name: '人民币兑美元（在岸）',
    englishName: 'CNY/USD · Onshore',
    unit: '美元/人民币',
    currency: 'USD',
    precision: 6,
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
