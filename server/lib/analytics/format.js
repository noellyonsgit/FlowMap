export const COLLAPSED = "Visits are recorded, but only for the first screen, so this path can't be timed yet."
export const UNMEASURED = "The app can show this, and it doesn't record when someone sees it."
export const WRONG_ACCOUNT = "This account can't see that site. Switch to the Google account your company uses for the website."
export const NOT_ENOUGH = 'Not enough days of visits since this change to compare yet.'
export const DROP_OFF_UNREAD = 'How many people leave along this path could not be read. Time on each screen is still shown.'

export function analyticsLine({ measurementId, gtmId } = {}) {
  if (measurementId) return 'This app records visits with Google Analytics.'
  if (gtmId) return 'This app records visits with Google Tag Manager. Connect Google and choose the site.'
  return "We couldn't see a visitor counter in the project. Connect Google and choose the site."
}

export function formatDay(iso, today = new Date()) {
  const [year, month, day] = String(iso).split('-').map(Number)
  if (!year || !month || !day) return String(iso || '')
  const date = new Date(year, month - 1, day)
  const sameYear = date.getFullYear() === today.getFullYear()
  return date.toLocaleDateString('en-GB', sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })
}

export function formatSpan(seconds) {
  const line = formatTime(seconds)
  return line ? line.replace(/\s+here$/, '') : null
}

export function formatReach(sessions) {
  if (!Number.isFinite(sessions) || sessions <= 0) return null
  const count = Math.round(sessions)
  return count === 1 ? 'Seen in 1 visit' : `Seen in ${count.toLocaleString('en-GB')} visits`
}

export function formatVisitNote(summary) {
  const source = summary || {}
  const count = Math.round(source.sessions || 0)
  if (count <= 0) return null
  const parts = [count === 1 ? '1 visit' : `${count.toLocaleString('en-GB')} visits`]
  if (Number.isFinite(source.bounceRate) && count >= 10) parts.push(`${Math.round(source.bounceRate * 100)}% left straight away`)
  const span = formatSpan(source.averageSessionDuration)
  if (span && count >= 10) parts.push(`A visit lasts ${span.charAt(0).toLowerCase()}${span.slice(1)}`)
  return parts.length === 1 ? parts[0] : `${parts.join('. ')}.`
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  if (seconds < 50) {
    const n = Math.max(5, Math.round(seconds / 5) * 5)
    return `About ${n} seconds here`
  }
  if (seconds < 90) return 'About 1 minute here'
  const minutes = seconds / 60
  if (minutes < 10) {
    const rounded = Math.round(minutes * 2) / 2
    const label = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
    const unit = rounded === 1 ? 'minute' : 'minutes'
    return `About ${label} ${unit} here`
  }
  const whole = Math.round(minutes)
  return `About ${whole} minutes here`
}

export function formatLeave(rate, nextName) {
  if (!Number.isFinite(rate) || !nextName) return null
  return `${Math.round(rate * 100)}% leave before ${nextName}`
}

export function formatFinish(rate) {
  if (!Number.isFinite(rate)) return null
  return `${Math.round(rate * 100)}% finish this path`
}

export function formatShare(rate) {
  if (!Number.isFinite(rate)) return null
  return `${Math.round(rate * 100)}% of visits see this`
}

export function withWas(line, was) {
  if (!line) return null
  if (!was) return line
  const earlier = was.replace(/\s+here$/, '')
  return `${line} · was ${earlier.charAt(0).toLowerCase()}${earlier.slice(1)}`
}

export function recordedNote(day, today) {
  return `Recorded in the project on ${formatDay(day, today)}. The site may have gone live later.`
}

export function muddyNote(count) {
  const updates = count === 1 ? '1 update' : `${count} updates`
  return `${updates} shipped in this window, so the shift covers all of them.`
}

export function percentWas(rate) {
  if (!Number.isFinite(rate)) return null
  return `${Math.round(rate * 100)}%`
}
