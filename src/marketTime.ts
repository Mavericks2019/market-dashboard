export type MarketPhase = 'open' | 'maintenance' | 'weekend'

export interface SessionState {
  phase: MarketPhase
  label: string
  detail: string
}

function nyParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || ''
  return {
    weekday: value('weekday'),
    minutes: Number(value('hour')) % 24 * 60 + Number(value('minute')),
  }
}

export function getSessionState(date = new Date()): SessionState {
  const { weekday, minutes } = nyParts(date)
  const isSaturday = weekday === 'Sat'
  const isSundayBeforeOpen = weekday === 'Sun' && minutes < 18 * 60
  const isFridayAfterClose = weekday === 'Fri' && minutes >= 17 * 60

  if (isSaturday || isSundayBeforeOpen || isFridayAfterClose) {
    return { phase: 'weekend', label: '周末休市', detail: '电子盘周日 18:00 ET 开盘' }
  }
  if (minutes >= 17 * 60 && minutes < 18 * 60) {
    return { phase: 'maintenance', label: '每日结算', detail: '18:00 ET 恢复电子盘' }
  }
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) {
    return { phase: 'open', label: '美股正盘', detail: 'CME 电子盘交易中' }
  }
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) {
    return { phase: 'open', label: '盘前 / 夜盘', detail: 'CME 电子盘交易中' }
  }
  return { phase: 'open', label: '盘后 / 夜盘', detail: 'CME 电子盘交易中' }
}

export function getCashSessionState(date = new Date()): SessionState {
  const { weekday, minutes } = nyParts(date)
  if (weekday === 'Sat' || weekday === 'Sun') {
    return { phase: 'weekend', label: '美股休市', detail: '现金市场周一开盘' }
  }
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) {
    return { phase: 'open', label: '美股正盘', detail: '纳斯达克现金市场交易中' }
  }
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) {
    return { phase: 'maintenance', label: '美股盘前', detail: '09:30 ET 现金市场开盘' }
  }
  return { phase: 'weekend', label: '美股已收盘', detail: '显示最近交易数据' }
}

export function formatChinaTime(seconds: number | null, includeDate = false) {
  if (!seconds) return '--:--:--'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: includeDate ? '2-digit' : undefined,
    day: includeDate ? '2-digit' : undefined,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(seconds * 1000))
}

export function formatNewYorkTime(date = new Date()) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)
}
