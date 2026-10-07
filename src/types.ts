export type Period = '1D' | '5D' | '1M' | '3M' | '1Y' | '5Y' | 'MAX'

export interface ChartPoint {
  time: number
  open: number | null
  high: number | null
  low: number | null
  close: number
  volume: number | null
}

export interface Market {
  key: 'NQ' | 'NDX' | 'IXIC' | 'ES' | 'SPX' | 'YM' | 'DJI' | 'XAU' | 'BRKB' | 'GOOGL' | 'NVDA' | 'AAPL' | 'SPCX' | 'KO' | 'MCD' | 'PDD' | 'TENCENT' | 'UNITREE' | 'SSE' | 'SZSE' | 'ChiNext' | 'CSI_DIV' | 'CSI_DIV_LV' | 'CSI_DIV_LV100' | 'SSE_DIV' | 'FTSE' | 'DAX' | 'KOSPI' | 'NIKKEI' | 'CFETS' | 'USDCNY' | 'HSBC' | 'STAN' | 'HSTECH'
  symbol: string
  name: string
  englishName: string
  contract: string
  kind: 'futures' | 'index' | 'stock' | 'metal' | 'forex'
  unit: string
  currency: string
  exchange: string
  price: number | null
  previousClose: number | null
  change: number | null
  changePercent: number | null
  dayHigh: number | null
  dayLow: number | null
  marketTime: number | null
  historyStart?: number | null
  historyEnd?: number | null
  exchangeTimezone: string
  dataGranularity: string
  precision?: number
  frequency?: string
  sourceName?: string
  sourceUrl?: string
  dataNote?: string
  isStale?: boolean
  watchStance?: 'bearish'
  points: ChartPoint[]
}

export interface MarketsResponse {
  asOf: number
  period: Period
  feed: string
  delay: string
  fx: { symbol: string; rate: number | null; marketTime: number | null } | null
  markets: Market[]
  errors: Array<{ key: string; message: string }>
  usCashSession?: { isOpen: boolean; phase: string; label: string; detail: string; marketDate?: string; openAt?: string; closeAt?: string }
}

export interface FundamentalRow {
  key: string
  symbol: string
  name: string
  englishName: string
  pe: number | null
  pb: number | null
  ps: number | null
  dividendYield: number | null
  marketTime: number | null
  reportDate?: string | null
  valuationDate?: string | null
  sourceName?: string
  sourceUrl?: string
  peBasis?: string
  pbBasis?: string
  psBasis?: string
  dividendBasis?: string
  note?: string
  isStale?: boolean
  watchStance?: 'bearish'
}

export interface FundamentalsResponse {
  asOf: number
  rows: FundamentalRow[]
}

export interface HousingIndexValues {
  momIndex: number | null
  yoyIndex: number | null
  levelIndex: number | null
}

export interface HousingRecord {
  month: string
  newHome: HousingIndexValues
  resale: HousingIndexValues
}

export interface HousingCity {
  id: string
  name: string
  records: HousingRecord[]
}

export interface HousingResponse {
  asOf: number
  latestMonth: string
  historyStart: string
  levelBaseMonth: string
  levelBaseValue: number
  sourceName: string
  sourceUrl: string
  frequency: string
  isStale: boolean
  note: string
  cities: HousingCity[]
}
