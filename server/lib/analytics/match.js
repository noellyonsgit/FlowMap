/** Turn a FlowMap route pattern into a full-path test. `*` is one address segment. */
export function patternToRegExp(pattern) {
  if (!pattern || pattern === '/') return /^\/?$/i
  const body = String(pattern)
    .split('/')
    .map((seg, index) => {
      if (index === 0) return ''
      if (seg === '*') return '[^/]+'
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('/')
  return new RegExp(`^${body}/?$`, 'i')
}

export function normalizePagePath(pagePath) {
  const path = String(pagePath || '').split(/[?#]/)[0].trim()
  if (!path || path === '(not set)') return ''
  const withSlash = path.startsWith('/') ? path : `/${path}`
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, '') : '/'
}

export function pathMatches(pagePath, pattern) {
  const path = normalizePagePath(pagePath)
  if (!path) return false
  return patternToRegExp(pattern || '/').test(path)
}

export function sumMatching(rows, pattern) {
  let views = 0
  let duration = 0
  let sessions = 0
  for (const row of rows) {
    if (!pathMatches(row.path, pattern)) continue
    views += row.views || 0
    duration += row.duration || 0
    sessions += row.sessions || 0
  }
  return { views, duration, sessions }
}

export function siteHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** A single address holding almost every visit means the app only records the first screen. */
export function visitsCollapsed(rows) {
  const total = rows.reduce((sum, row) => sum + (row.views || 0), 0)
  if (total < 30) return false
  const top = rows.reduce((max, row) => Math.max(max, row.views || 0), 0)
  return top / total >= 0.8
}
