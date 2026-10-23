export function isoDay(date) {
  const value = date instanceof Date ? date : new Date(date)
  const y = value.getFullYear()
  const m = String(value.getMonth() + 1).padStart(2, '0')
  const d = String(value.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function addDays(iso, count) {
  const [year, month, day] = iso.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  date.setDate(date.getDate() + count)
  return isoDay(date)
}

export function daysInclusive(start, end) {
  const [ys, ms, ds] = start.split('-').map(Number)
  const [ye, me, de] = end.split('-').map(Number)
  const a = new Date(ys, ms - 1, ds)
  const b = new Date(ye, me - 1, de)
  return Math.round((b - a) / 86400000) + 1
}

/** Equal days before the change and after it, starting the day after it went live. */
export function comparisonFor(change, all, today = new Date()) {
  const todayIso = typeof today === 'string' ? today : isoDay(today)
  const yesterday = addDays(todayIso, -1)
  const afterStart = addDays(change.day, 1)
  let afterEnd = addDays(afterStart, 13)
  if (afterEnd > yesterday) afterEnd = yesterday
  if (afterStart > afterEnd) return { enough: false }
  const days = daysInclusive(afterStart, afterEnd)
  if (days < 7) return { enough: false }
  const beforeEnd = addDays(change.day, -1)
  const beforeStart = addDays(beforeEnd, -(days - 1))
  const covered = (all || []).filter((item) => item.day >= beforeStart && item.day <= afterEnd)
  return {
    enough: true,
    days,
    before: { start: beforeStart, end: beforeEnd },
    after: { start: afterStart, end: afterEnd },
    total: covered.length,
  }
}

export function defaultChangeId(changes, today = new Date()) {
  const newest = changes?.[0]
  if (newest && comparisonFor(newest, changes, today).enough) return newest.id
  return 'none'
}

export function last28(today = new Date()) {
  const todayIso = typeof today === 'string' ? today : isoDay(today)
  return { start: addDays(todayIso, -28), end: addDays(todayIso, -1) }
}
