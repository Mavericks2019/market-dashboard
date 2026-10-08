import type { FundamentalRow, IndexConstituent } from './types'

export type ConstituentSortKey = 'marketCap' | 'pe' | 'pb' | 'ps' | 'dividendYield'
export type ConstituentSortDirection = 'ascending' | 'descending'
export interface ConstituentSort { key: ConstituentSortKey; direction: ConstituentSortDirection }

export function toggleConstituentSort(previous: ConstituentSort, key: ConstituentSortKey): ConstituentSort {
  return { key, direction: previous.key === key && previous.direction === 'descending' ? 'ascending' : 'descending' }
}

function comparableValue(row: FundamentalRow | null | undefined, key: ConstituentSortKey) {
  // An explicit null means the source could not provide a comparable currency
  // value. Only an omitted sort value falls back to the displayed market cap.
  const value = key === 'marketCap'
    ? row?.marketCapSortValue !== undefined ? row.marketCapSortValue : row?.marketCap
    : row?.[key]
  if (value == null || !Number.isFinite(value)) return null
  if ((key === 'marketCap' || key === 'pe' || key === 'pb') && value <= 0) return null
  return value
}

export function sortConstituents(
  rows: readonly IndexConstituent[],
  valuations: ReadonlyMap<string, { row: FundamentalRow | null }>,
  sort: ConstituentSort,
) {
  return rows.map((company, originalPosition) => ({
    company, originalPosition, value: comparableValue(valuations.get(company.key)?.row, sort.key),
  })).sort((a, b) => {
    // Missing values and PE/PB shown as “not applicable” remain at the bottom
    // in both directions; ties retain the complete source list's order.
    if (a.value == null && b.value != null) return 1
    if (a.value != null && b.value == null) return -1
    const difference = a.value != null && b.value != null ? a.value - b.value : 0
    return (sort.direction === 'ascending' ? difference : -difference) || a.originalPosition - b.originalPosition
  }).map(({ company }) => company)
}
