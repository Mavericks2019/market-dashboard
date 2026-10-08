import type { ChartPoint, Market, MarketsResponse } from './types'

export function retainPoints(previous: ChartPoint[] | undefined, incoming: ChartPoint[]) {
  if (!previous || previous.length !== incoming.length) return incoming
  return previous.every((point, index) => {
    const next = incoming[index]
    return point.time === next.time && point.close === next.close && point.open === next.open
      && point.high === next.high && point.low === next.low && point.volume === next.volume
  }) ? previous : incoming
}

function hasPrice(market: Market) {
  return market.price != null && Number.isFinite(market.price) && market.marketTime != null
}

export function keepLatestQuote(previous: Market | undefined, incoming: Market): Market {
  if (!previous || previous.key !== incoming.key || !hasPrice(previous)) return incoming
  if (!hasPrice(incoming) || previous.marketTime! > incoming.marketTime!) {
    return { ...incoming, price: previous.price, previousClose: previous.previousClose,
      change: previous.change, changePercent: previous.changePercent,
      dayHigh: previous.dayHigh, dayLow: previous.dayLow, marketTime: previous.marketTime,
      isStale: true }
  }
  return incoming
}

export function mergeMarketSnapshot(previous: MarketsResponse | null, incoming: MarketsResponse): MarketsResponse {
  const prior = new Map(previous?.markets.map((market) => [market.key, market]))
  return { ...incoming, markets: incoming.markets.map((market) => keepLatestQuote(prior.get(market.key), market)) }
}

export function mergeQuoteAndHistory(quote: Market, history: Market | null): Market {
  if (!history || history.key !== quote.key) return { ...quote, points: [] }
  const snapshot = keepLatestQuote(history, quote)
  return { ...history, price: snapshot.price, previousClose: snapshot.previousClose,
    change: snapshot.change, changePercent: snapshot.changePercent,
    dayHigh: snapshot.dayHigh, dayLow: snapshot.dayLow, marketTime: snapshot.marketTime,
    isStale: Boolean(snapshot.isStale || history.isStale) }
}
