import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getUsCashSession,
  zonedTimeToEpoch,
  US_EASTERN_TIME_ZONE,
} from './us-session.mjs'

const atEt = (value) => new Date(zonedTimeToEpoch(value, US_EASTERN_TIME_ZONE))

test('regular cash session is closed before the open and opens at 09:30 ET', () => {
  assert.equal(getUsCashSession(atEt('2026-01-06T09:29:59')).isOpen, false)
  const atOpen = getUsCashSession(atEt('2026-01-06T09:30:00'))
  assert.equal(atOpen.phase, 'open')
  assert.equal(atOpen.isOpen, true)
  assert.equal(atOpen.marketDate, '2026-01-06')
  assert.equal(atOpen.closeAt, zonedTimeToEpoch('2026-01-06T16:00'))
})

test('regular session closes at exactly 16:00 ET', () => {
  assert.equal(getUsCashSession(atEt('2026-01-06T15:59:59')).isOpen, true)
  const closed = getUsCashSession(atEt('2026-01-06T16:00:00'))
  assert.equal(closed.isOpen, false)
  assert.match(closed.label, /已收盘/)
})

test('weekends are closed and provide the next open', () => {
  const result = getUsCashSession(atEt('2026-01-10T12:00:00')) // Saturday
  assert.equal(result.phase, 'closed')
  assert.equal(result.isOpen, false)
  assert.match(result.label, /周末休市/)
  assert.equal(new Date(result.nextOpenAt).toISOString(), '2026-01-12T14:30:00.000Z')
})

test('official full-day holidays are closed', () => {
  const result = getUsCashSession(atEt('2026-01-19T12:00:00')) // MLK Day
  assert.equal(result.isOpen, false)
  assert.equal(result.holiday, 'Martin Luther King Jr. Day')
  assert.equal(result.holidayOfficial, true)
})

test('official early-close dates trade only through 13:00 ET', () => {
  const before = getUsCashSession(atEt('2028-07-03T12:59:59'))
  assert.equal(before.isOpen, true)
  assert.equal(before.earlyClose, '13:00')
  const after = getUsCashSession(atEt('2028-07-03T13:00:00'))
  assert.equal(after.isOpen, false)
  assert.equal(after.closeAt, zonedTimeToEpoch('2028-07-03T13:00'))
})

test('the 2028 Saturday New Year holiday follows the official no-observed-closure exception', () => {
  const result = getUsCashSession(atEt('2027-12-31T10:00:00'))
  assert.equal(result.isOpen, true)
  assert.equal(result.holiday, null)
})

test('DST switches are reflected in epoch conversion while cash hours stay 09:30 ET', () => {
  const winterOpen = zonedTimeToEpoch('2026-01-06T09:30')
  const summerOpen = zonedTimeToEpoch('2026-07-06T09:30')
  assert.equal(new Date(winterOpen).toISOString(), '2026-01-06T14:30:00.000Z')
  assert.equal(new Date(summerOpen).toISOString(), '2026-07-06T13:30:00.000Z')
  assert.equal(getUsCashSession(atEt('2026-07-06T09:30')).isOpen, true)
})

test('zonedTimeToEpoch supports a non-US zone for reusable schedule calculations', () => {
  const epoch = zonedTimeToEpoch('2026-01-01T09:00', 'Asia/Shanghai')
  assert.equal(new Date(epoch).toISOString(), '2026-01-01T01:00:00.000Z')
})

test('years outside the published table use transparent exchange rules', () => {
  const thanksgivingFriday = getUsCashSession(atEt('2029-11-23T12:59:59'))
  assert.equal(thanksgivingFriday.isOpen, true)
  assert.equal(thanksgivingFriday.earlyClose, '13:00')
  assert.equal(thanksgivingFriday.holidayOfficial, false)

  const invalid = () => zonedTimeToEpoch('2029-02-30T09:30')
  assert.throws(invalid, RangeError)
})
