import test from 'node:test'
import assert from 'node:assert/strict'
import { sortConstituents, toggleConstituentSort } from './src/constituentSort.ts'

const company = (key) => ({ key, symbol: key, name: key, englishName: key, market: 'US' })
const sortedKeys = (rows, values, key, direction) => sortConstituents(rows, values, { key, direction }).map((row) => row.key)
const valuations = (values) => new Map(Object.entries(values).map(([key, row]) => [key, { row }]))

test('a selected column toggles direction; another column starts descending', () => {
  const initial = { key: 'marketCap', direction: 'descending' }
  const ascending = toggleConstituentSort(initial, 'marketCap')
  assert.deepEqual(ascending, { key: 'marketCap', direction: 'ascending' })
  assert.deepEqual(toggleConstituentSort(ascending, 'marketCap'), initial)
  assert.deepEqual(toggleConstituentSort(initial, 'pe'), { key: 'pe', direction: 'descending' })
})

test('market caps use comparable currency values and missing values remain last in both directions', () => {
  const rows = ['converted', 'local', 'incomparable', 'missing', 'zero', 'invalid'].map(company)
  const values = valuations({
    converted: { marketCap: 10, marketCapSortValue: 70 }, local: { marketCap: 60 },
    incomparable: { marketCap: 1000, marketCapSortValue: null }, missing: null,
    zero: { marketCap: 0 }, invalid: { marketCap: Infinity },
  })
  assert.deepEqual(sortedKeys(rows, values, 'marketCap', 'descending'), ['converted', 'local', 'incomparable', 'missing', 'zero', 'invalid'])
  assert.deepEqual(sortedKeys(rows, values, 'marketCap', 'ascending'), ['local', 'converted', 'incomparable', 'missing', 'zero', 'invalid'])
})

test('nonpositive PE and PB match the displayed not-applicable status and sort after valid ratios', () => {
  const rows = ['loss', 'small', 'zero', 'large', 'missing', 'invalid', 'pending'].map(company)
  for (const metric of ['pe', 'pb']) {
    const values = valuations({ loss: { [metric]: -5 }, small: { [metric]: 2 }, zero: { [metric]: 0 }, large: { [metric]: 10 }, missing: { [metric]: null }, invalid: { [metric]: NaN } })
    assert.deepEqual(sortedKeys(rows, values, metric, 'ascending'), ['small', 'large', 'loss', 'zero', 'missing', 'invalid', 'pending'])
    assert.deepEqual(sortedKeys(rows, values, metric, 'descending'), ['large', 'small', 'loss', 'zero', 'missing', 'invalid', 'pending'])
  }
})

test('zero dividend yield is a real value, and every sortable metric keeps equal values stable', () => {
  const rows = ['missing', 'one', 'zero', 'two', 'invalid'].map(company)
  for (const metric of ['ps', 'dividendYield']) {
    const values = valuations({ missing: { [metric]: null }, one: { [metric]: 4 }, zero: { [metric]: 0 }, two: { [metric]: 4 }, invalid: { [metric]: Infinity } })
    assert.deepEqual(sortedKeys(rows, values, metric, 'ascending'), ['zero', 'one', 'two', 'missing', 'invalid'])
    assert.deepEqual(sortedKeys(rows, values, metric, 'descending'), ['one', 'two', 'zero', 'missing', 'invalid'])
  }
})

test('sorting covers the complete 3391-member list before slicing and updates when late valuations arrive', () => {
  const rows = Array.from({ length: 3391 }, (_, index) => company(String(index)))
  const values = new Map(rows.map((row, index) => [row.key, { row: { pe: index + 1 } }]))
  const first = sortConstituents(rows, values, { key: 'pe', direction: 'descending' })
  assert.equal(first.length, rows.length)
  assert.equal(first[0].key, '3390')
  assert.equal(new Set(first.map((row) => row.key)).size, rows.length)
  assert.equal(rows[0].key, '0')
  values.set('0', { row: { pe: 10000 } })
  assert.equal(sortConstituents(rows, values, { key: 'pe', direction: 'descending' })[0].key, '0')
})
