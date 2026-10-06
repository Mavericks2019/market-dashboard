/**
 * NYSE/Nasdaq core cash-session calendar.
 *
 * Times are returned as epoch milliseconds and are calculated in
 * America/New_York, so the caller does not need to know whether the date is
 * in Eastern Standard Time (UTC-5) or Eastern Daylight Time (UTC-4).
 *
 * The 2026-2028 holiday dates and early closes mirror the published NYSE
 * calendar.  For years outside that published range the usual US exchange
 * holiday rules are generated (and the result is marked as rule based).
 */

export const US_EASTERN_TIME_ZONE = 'America/New_York'
export const NYSE_CALENDAR_URL = 'https://www.nyse.com/trade/hours-calendars'

const OPEN_TIME = '09:30'
const REGULAR_CLOSE_TIME = '16:00'
const EARLY_CLOSE_TIME = '13:00'

const DAY_NAMES = Object.freeze({
  newYearsDay: "New Year's Day",
  mlk: 'Martin Luther King Jr. Day',
  washington: "Washington's Birthday",
  goodFriday: 'Good Friday',
  memorial: 'Memorial Day',
  juneteenth: 'Juneteenth National Independence Day',
  independence: 'Independence Day',
  labor: 'Labor Day',
  thanksgiving: 'Thanksgiving Day',
  christmas: 'Christmas Day',
})

const CHINESE_DAY_NAMES = Object.freeze({
  [DAY_NAMES.newYearsDay]: '元旦',
  [DAY_NAMES.mlk]: '马丁·路德·金纪念日',
  [DAY_NAMES.washington]: '华盛顿诞辰日',
  [DAY_NAMES.goodFriday]: '耶稣受难日',
  [DAY_NAMES.memorial]: '阵亡将士纪念日',
  [DAY_NAMES.juneteenth]: '六月节',
  [DAY_NAMES.independence]: '独立日',
  [DAY_NAMES.labor]: '劳动节',
  [DAY_NAMES.thanksgiving]: '感恩节',
  [DAY_NAMES.christmas]: '圣诞节',
})

// Official NYSE 2026-2028 dates.  A value is the date observed by the
// exchange, rather than necessarily the calendar date of the holiday.
const OFFICIAL_HOLIDAYS = Object.freeze({
  2026: Object.freeze({
    '2026-01-01': DAY_NAMES.newYearsDay,
    '2026-01-19': DAY_NAMES.mlk,
    '2026-02-16': DAY_NAMES.washington,
    '2026-04-03': DAY_NAMES.goodFriday,
    '2026-05-25': DAY_NAMES.memorial,
    '2026-06-19': DAY_NAMES.juneteenth,
    '2026-07-03': `${DAY_NAMES.independence} (observed)`,
    '2026-09-07': DAY_NAMES.labor,
    '2026-11-26': DAY_NAMES.thanksgiving,
    '2026-12-25': DAY_NAMES.christmas,
  }),
  2027: Object.freeze({
    '2027-01-01': DAY_NAMES.newYearsDay,
    '2027-01-18': DAY_NAMES.mlk,
    '2027-02-15': DAY_NAMES.washington,
    '2027-03-26': DAY_NAMES.goodFriday,
    '2027-05-31': DAY_NAMES.memorial,
    '2027-06-18': `${DAY_NAMES.juneteenth} (observed)`,
    '2027-07-05': `${DAY_NAMES.independence} (observed)`,
    '2027-09-06': DAY_NAMES.labor,
    '2027-11-25': DAY_NAMES.thanksgiving,
    '2027-12-24': `${DAY_NAMES.christmas} (observed)`,
  }),
  2028: Object.freeze({
    // NYSE explicitly publishes no additional closure for Saturday Jan 1.
    '2028-01-17': DAY_NAMES.mlk,
    '2028-02-21': DAY_NAMES.washington,
    '2028-04-14': DAY_NAMES.goodFriday,
    '2028-05-29': DAY_NAMES.memorial,
    '2028-06-19': DAY_NAMES.juneteenth,
    '2028-07-04': DAY_NAMES.independence,
    '2028-09-04': DAY_NAMES.labor,
    '2028-11-23': DAY_NAMES.thanksgiving,
    '2028-12-25': DAY_NAMES.christmas,
  }),
})

const OFFICIAL_EARLY_CLOSES = Object.freeze({
  '2026-11-27': 'Day after Thanksgiving',
  '2026-12-24': 'Christmas Eve',
  '2027-11-26': 'Day after Thanksgiving',
  '2028-07-03': 'Day before Independence Day',
  '2028-11-24': 'Day after Thanksgiving',
})

const dateOnlyFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: US_EASTERN_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

const displayFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: US_EASTERN_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

function pad(value) {
  return String(value).padStart(2, '0')
}

function isoDate(year, month, day) {
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`
}

function parseDateOnly(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) throw new RangeError(`Invalid calendar date: ${value}`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const result = new Date(Date.UTC(year, month - 1, day))
  if (
    result.getUTCFullYear() !== year ||
    result.getUTCMonth() !== month - 1 ||
    result.getUTCDate() !== day
  ) {
    throw new RangeError(`Invalid calendar date: ${value}`)
  }
  return result
}

function addDays(dateString, count) {
  const date = parseDateOnly(dateString)
  date.setUTCDate(date.getUTCDate() + count)
  return isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
}

function weekday(dateString) {
  return parseDateOnly(dateString).getUTCDay()
}

function toDateParts(date) {
  const input = date instanceof Date ? date : new Date(date)
  if (!(input instanceof Date) || Number.isNaN(input.getTime())) {
    throw new RangeError('date must be a valid Date')
  }
  const parts = Object.fromEntries(
    dateOnlyFormatter.formatToParts(input).map(({ type, value }) => [type, value]),
  )
  const dateString = isoDate(parts.year, parts.month, parts.day)
  return {
    input,
    dateString,
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: weekday(dateString),
  }
}

function offsetMinutesAt(epoch, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'shortOffset',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(epoch))
  const raw = parts.find(({ type }) => type === 'timeZoneName')?.value ?? 'GMT'
  if (raw === 'GMT' || raw === 'UTC') return 0
  const match = /^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(raw)
  if (!match) throw new Error(`Unable to parse ${timeZone} offset: ${raw}`)
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0)
  return match[1] === '-' ? -minutes : minutes
}

/** Convert a local wall-clock timestamp to epoch milliseconds in a named zone. */
export function zonedTimeToEpoch(dateTimeString, timeZone = US_EASTERN_TIME_ZONE) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    dateTimeString,
  )
  if (!match) throw new RangeError(`Invalid local date/time: ${dateTimeString}`)
  const components = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
  }
  if (
    components.hour > 23 ||
    components.minute > 59 ||
    components.second > 59
  ) {
    throw new RangeError(`Invalid local date/time: ${dateTimeString}`)
  }
  const asUtc = Date.UTC(
    components.year,
    components.month - 1,
    components.day,
    components.hour,
    components.minute,
    components.second,
  )
  const check = new Date(asUtc)
  if (
    check.getUTCFullYear() !== components.year ||
    check.getUTCMonth() !== components.month - 1 ||
    check.getUTCDate() !== components.day
  ) {
    throw new RangeError(`Invalid local date/time: ${dateTimeString}`)
  }
  // Two passes are enough for the US DST offsets and make 09:30/16:00 exact.
  let epoch = asUtc
  for (let i = 0; i < 3; i += 1) {
    epoch = asUtc - offsetMinutesAt(epoch, timeZone) * 60_000
  }
  return epoch
}

function nthWeekday(year, month, dayOfWeek, ordinal) {
  const first = new Date(Date.UTC(year, month - 1, 1))
  const offset = (dayOfWeek - first.getUTCDay() + 7) % 7
  return isoDate(year, month, 1 + offset + (ordinal - 1) * 7)
}

function lastWeekday(year, month, dayOfWeek) {
  const last = new Date(Date.UTC(year, month, 0))
  const offset = (last.getUTCDay() - dayOfWeek + 7) % 7
  return isoDate(year, month, last.getUTCDate() - offset)
}

// Gregorian computus, returning Easter Sunday as a date-only string.
function easterSunday(year) {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return isoDate(year, month, day)
}

function observedDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day))
  const dayOfWeek = date.getUTCDay()
  if (dayOfWeek === 6) date.setUTCDate(day - 1)
  if (dayOfWeek === 0) date.setUTCDate(day + 1)
  return isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
}

function buildRuleHolidayMap(year) {
  const map = new Map()
  const add = (date, name) => map.set(date, name)

  // New Year's Day can be observed on Dec 31 of the prior year, so include
  // adjacent years when constructing a map for a date near year boundaries.
  for (const holidayYear of [year - 1, year, year + 1]) {
    // The official 2028 calendar explicitly has no Jan 1 closure because it
    // falls on Saturday; preserve that published exception.
    if (holidayYear !== 2028) add(observedDate(holidayYear, 1, 1), DAY_NAMES.newYearsDay)
  }

  add(nthWeekday(year, 1, 1, 3), DAY_NAMES.mlk)
  add(nthWeekday(year, 2, 1, 3), DAY_NAMES.washington)
  add(addDays(easterSunday(year), -2), DAY_NAMES.goodFriday)
  add(lastWeekday(year, 5, 1), DAY_NAMES.memorial)
  if (year >= 2022) add(observedDate(year, 6, 19), DAY_NAMES.juneteenth)
  add(observedDate(year, 7, 4), DAY_NAMES.independence)
  add(nthWeekday(year, 9, 1, 1), DAY_NAMES.labor)
  add(nthWeekday(year, 11, 4, 4), DAY_NAMES.thanksgiving)
  add(observedDate(year, 12, 25), DAY_NAMES.christmas)
  return map
}

function holidayFor(dateString, year) {
  if (OFFICIAL_HOLIDAYS[year]?.[dateString]) {
    return { name: OFFICIAL_HOLIDAYS[year][dateString], official: true }
  }
  const name = buildRuleHolidayMap(year).get(dateString)
  return name ? { name, official: false } : null
}

function earlyCloseFor(dateString) {
  const reason = OFFICIAL_EARLY_CLOSES[dateString]
  if (reason) return { time: EARLY_CLOSE_TIME, reason, official: true }

  // For dates outside the published 2026-2028 calendar, apply the stable
  // exchange rules and mark the result as rule based.  Never turn a full
  // holiday into an early-close session.
  const year = Number(dateString.slice(0, 4))
  const month = Number(dateString.slice(5, 7))
  const day = Number(dateString.slice(8, 10))
  const dateWeekday = weekday(dateString)
  const fullHoliday = holidayFor(dateString, year)
  if (fullHoliday) return null

  const thanksgivingFriday = addDays(nthWeekday(year, 11, 4, 4), 1)
  if (dateString === thanksgivingFriday) {
    return { time: EARLY_CLOSE_TIME, reason: 'Day after Thanksgiving', official: false }
  }

  // The session before Independence Day closes early when July 4 falls Tue–Fri.
  const independenceWeekday = weekday(isoDate(year, 7, 4))
  if (month === 7 && day === 3 && independenceWeekday >= 2 && independenceWeekday <= 5) {
    return { time: EARLY_CLOSE_TIME, reason: 'Day before Independence Day', official: false }
  }

  // Christmas Eve is an early close when it is a weekday and Christmas itself
  // is not observed as a full-day closure on that date.
  if (month === 12 && day === 24 && dateWeekday >= 1 && dateWeekday <= 5) {
    return { time: EARLY_CLOSE_TIME, reason: 'Christmas Eve', official: false }
  }
  return null
}

function makeTime(dateString, time) {
  return zonedTimeToEpoch(`${dateString}T${time}`, US_EASTERN_TIME_ZONE)
}

function nextOpenEpoch(afterEpoch, includeCurrentDate = true) {
  const current = toDateParts(new Date(afterEpoch))
  let cursor = current.dateString
  for (let i = 0; i < 370; i += 1) {
    const currentWeekday = weekday(cursor)
    const holiday = holidayFor(cursor, Number(cursor.slice(0, 4)))
    if (currentWeekday !== 0 && currentWeekday !== 6 && !holiday) {
      const openAt = makeTime(cursor, OPEN_TIME)
      if ((includeCurrentDate && openAt > afterEpoch) || (!includeCurrentDate && openAt >= afterEpoch)) {
        return openAt
      }
    }
    cursor = addDays(cursor, 1)
    includeCurrentDate = true
  }
  return null
}

function isoOrNull(epoch) {
  return epoch == null ? null : new Date(epoch).toISOString()
}

function displayTime(epoch) {
  return displayFormatter.format(new Date(epoch))
}

function sessionResult({
  now,
  marketDate,
  holiday,
  earlyClose,
  openAt = null,
  closeAt = null,
  phase,
  isOpen,
  label,
  detail,
  nextOpenAt = null,
}) {
  return {
    phase,
    isOpen,
    label,
    detail,
    session: 'cash',
    market: 'NYSE/Nasdaq',
    marketDate,
    timezone: US_EASTERN_TIME_ZONE,
    calendarSource: holiday?.official || earlyClose?.official ? NYSE_CALENDAR_URL : 'NYSE rule-based calendar',
    holiday: holiday?.name ?? null,
    holidayOfficial: holiday?.official ?? false,
    earlyClose: earlyClose ? earlyClose.time : null,
    earlyCloseReason: earlyClose?.reason ?? null,
    openAt,
    closeAt,
    openAtIso: isoOrNull(openAt),
    closeAtIso: isoOrNull(closeAt),
    nextOpenAt,
    nextOpenAtIso: isoOrNull(nextOpenAt),
    now: now.toISOString(),
  }
}

/**
 * Return the NYSE/Nasdaq core cash-session state for an instant.
 *
 * The regular session is 09:30-16:00 America/New_York.  On published early
 * close dates it ends at 13:00.  Weekends and exchange holidays are closed.
 */
export function getUsCashSession(date = new Date()) {
  const parts = toDateParts(date)
  const now = parts.input
  const marketDate = parts.dateString
  const holiday = holidayFor(marketDate, parts.year)
  const earlyClose = earlyCloseFor(marketDate)
  const openAt = makeTime(marketDate, OPEN_TIME)
  const closeAt = makeTime(marketDate, earlyClose?.time ?? REGULAR_CLOSE_TIME)
  const weekend = parts.weekday === 0 || parts.weekday === 6

  if (weekend || holiday) {
    const nextOpenAt = nextOpenEpoch(now.getTime())
    const label = weekend ? '美股周末休市' : `${CHINESE_DAY_NAMES[holiday.name?.replace(' (observed)', '')] ?? '节假日'}休市`
    const detail = weekend
      ? 'NYSE / Nasdaq 现金市场周末不交易'
      : `NYSE / Nasdaq 因${CHINESE_DAY_NAMES[holiday.name?.replace(' (observed)', '')] ?? holiday.name}休市`
    return sessionResult({
      now,
      marketDate,
      holiday,
      earlyClose,
      phase: 'closed',
      isOpen: false,
      label,
      detail,
      nextOpenAt,
    })
  }

  if (now.getTime() >= openAt && now.getTime() < closeAt) {
    const schedule = earlyClose
      ? `今日提前收盘 ${earlyClose.time} ET`
      : '今日 09:30–16:00 ET'
    return sessionResult({
      now,
      marketDate,
      holiday,
      earlyClose,
      openAt,
      closeAt,
      phase: 'open',
      isOpen: true,
      label: earlyClose ? '美股正盘交易中（提前收盘）' : '美股正盘交易中',
      detail: `NYSE / Nasdaq 现金市场 · ${schedule}`,
      nextOpenAt: null,
    })
  }

  const nextOpenAt = now.getTime() < openAt ? openAt : nextOpenEpoch(now.getTime())
  const beforeOpen = now.getTime() < openAt
  return sessionResult({
    now,
    marketDate,
    holiday,
    earlyClose,
    openAt,
    closeAt,
    phase: 'closed',
    isOpen: false,
    label: beforeOpen ? '美股正盘尚未开盘' : '美股正盘已收盘',
    detail: beforeOpen
      ? `今日 ${displayTime(openAt)} 开盘`
      : `今日 ${displayTime(closeAt)} 收盘`,
    nextOpenAt,
  })
}

export const usSessionConstants = Object.freeze({
  openTime: OPEN_TIME,
  regularCloseTime: REGULAR_CLOSE_TIME,
  earlyCloseTime: EARLY_CLOSE_TIME,
  timeZone: US_EASTERN_TIME_ZONE,
})
