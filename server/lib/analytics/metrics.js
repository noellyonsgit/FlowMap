import { eventForEvidence } from './detect.js'
import {
  COLLAPSED,
  DROP_OFF_UNREAD,
  NOT_ENOUGH,
  UNMEASURED,
  formatFinish,
  formatLeave,
  formatReach,
  formatShare,
  formatSpan,
  formatTime,
  muddyNote,
  percentWas,
  recordedNote,
  withWas,
} from './format.js'
import { pathMatches, sumMatching, visitsCollapsed } from './match.js'
import { comparisonFor, defaultChangeId, last28 } from './windows.js'

function timeLine(rows, pattern) {
  const { views, duration } = sumMatching(rows, pattern)
  if (views <= 0) return { line: null, seconds: null }
  return { line: formatTime(duration / views), seconds: duration / views }
}

function reachLine(rows, pattern) {
  return formatReach(sumMatching(rows, pattern).sessions)
}

function visitSummary(summary) {
  if (!summary || !(summary.sessions > 0)) return null
  const sessions = Math.round(summary.sessions)
  return {
    sessions,
    left: Number.isFinite(summary.bounceRate) && sessions >= 10 ? Math.round(summary.bounceRate * 100) : null,
    span: sessions >= 10 ? formatSpan(summary.averageSessionDuration) : null,
  }
}

function shareLine(rows, pattern, eventName) {
  if (!eventName) return null
  const views = sumMatching(rows.pages || [], pattern).views
  if (views <= 0) return null
  let count = 0
  for (const row of rows.events || []) {
    if (row.eventName !== eventName) continue
    if (pathMatches(row.path, pattern)) count += row.count || 0
  }
  return formatShare(Math.min(1, count / views))
}

function happySteps(flow) {
  return flow.steps.filter((step) => step.kind === 'happy').sort((a, b) => a.col - b.col)
}

/**
 * Turn page, funnel, and event rows into the lines on one journey.
 * `before` is the earlier range when a change is selected.
 */
export function describeFlow(flow, current, before, options = {}) {
  const today = options.today || new Date()
  const change = options.change && options.change.id !== 'none' ? options.change : null
  const window = change ? comparisonFor(change, flow.changes || [], today) : null
  const collapsed = visitsCollapsed(current.pages || [])
  const happy = happySteps(flow)
  const funnel = collapsed ? null : current.funnel
  const notes = []
  if (collapsed && happy.length > 1) notes.push(COLLAPSED)
  if (change && window && !window.enough) notes.push(NOT_ENOUGH)
  if (change && window?.enough && !options.deployed) notes.push(recordedNote(change.day, today))
  if (change && window?.enough && window.total > 1) notes.push(muddyNote(window.total))
  if (!collapsed && options.funnelFailed && happy.length > 1) notes.push(DROP_OFF_UNREAD)
  const summary = visitSummary(current.summary)

  const comparing = Boolean(change && window?.enough && before)
  const steps = {}

  flow.steps.forEach((step) => {
    if (step.kind === 'unhappy') {
      const eventName = eventForEvidence(step.evidence, options.events)
      if (!eventName) {
        steps[step.id] = { unhappy: UNMEASURED }
        return
      }
      const share = shareLine(current, step.pattern || step.route, eventName)
      const earlier = comparing ? shareLine(before, step.pattern || step.route, eventName) : null
      steps[step.id] = { unhappy: withWas(share, earlier ? percentWas(shareRate(earlier)) : null) || UNMEASURED }
      return
    }
    if (step.kind !== 'happy' && step.kind !== 'edge') return
    const pattern = step.pattern || step.route
    const time = timeLine(current.pages || [], pattern)
    const earlier = comparing ? timeLine(before.pages || [], pattern) : null
    const matched = sumMatching(current.pages || [], pattern)
    const reach = reachLine(current.pages || [], pattern)
    const earlierReach = comparing ? reachLine(before.pages || [], pattern) : null
    const stat = {
      reach: withWas(reach, earlierReach),
      reachCount: Math.round(matched.sessions) || 0,
      time: withWas(time.line, earlier?.line || null),
    }
    if (step.kind === 'happy' && funnel) {
      const index = happy.findIndex((item) => item.id === step.id)
      const next = happy[index + 1]
      const rate = funnel[index]?.abandonRate
      if (next && Number.isFinite(rate)) {
        const leave = formatLeave(rate, next.name)
        const was = comparing && before.funnel ? percentWas(before.funnel[index]?.abandonRate) : null
        stat.leave = withWas(leave, was)
      }
    }
    steps[step.id] = stat
  })

  let finish = null
  if (funnel && happy.length > 1 && funnel[0]?.users > 0 && funnel[happy.length - 1]) {
    const rate = funnel[happy.length - 1].users / funnel[0].users
    const was = comparing && before.funnel?.[0]?.users > 0 ? percentWas(before.funnel[happy.length - 1].users / before.funnel[0].users) : null
    finish = withWas(formatFinish(rate), was)
  }

  return {
    id: flow.id,
    changeId: change?.id || 'none',
    headline: change ? `After ${change.name}` : 'Last 28 days',
    finish,
    summary,
    notes,
    steps,
  }
}

function shareRate(line) {
  const match = String(line || '').match(/(\d+)%/)
  return match ? Number(match[1]) / 100 : null
}

export function resolveChange(flow, requested, today = new Date()) {
  const changes = flow.changes || []
  if (requested === 'none') return null
  if (requested) return changes.find((change) => change.id === requested) || null
  const id = defaultChangeId(changes, today)
  return id === 'none' ? null : changes.find((change) => change.id === id) || null
}

export function rangeFor(flow, requested, today = new Date()) {
  const change = resolveChange(flow, requested, today)
  if (!change) return { change: null, current: last28(today), before: null }
  const window = comparisonFor(change, flow.changes || [], today)
  if (!window.enough) return { change, current: null, before: null, window }
  return { change, current: window.after, before: window.before, window }
}

export function parseReport(report) {
  const dims = (report.dimensionHeaders || []).map((header) => header.name)
  const mets = (report.metricHeaders || []).map((header) => header.name)
  return (report.rows || []).map((row) => {
    const out = {}
    dims.forEach((name, index) => {
      out[name] = row.dimensionValues[index]?.value
    })
    mets.forEach((name, index) => {
      out[name] = Number(row.metricValues[index]?.value)
    })
    return out
  })
}

export function pageRows(report) {
  return parseReport(report).map((row) => ({
    path: row.pagePath,
    views: row.screenPageViews || 0,
    duration: row.userEngagementDuration || 0,
    sessions: row.sessions || 0,
  }))
}

export function eventRows(report) {
  return parseReport(report).map((row) => ({
    eventName: row.eventName,
    path: row.pagePath,
    count: row.eventCount || 0,
  }))
}

export function funnelRows(report) {
  const table = report?.funnelTable
  if (!table) return null
  const dims = (table.dimensionHeaders || []).map((header) => header.name)
  const mets = (table.metricHeaders || []).map((header) => header.name)
  const stepIndex = dims.indexOf('funnelStepName')
  const usersIndex = mets.indexOf('activeUsers')
  const abandonIndex = mets.indexOf('funnelStepAbandonmentRate')
  const seen = new Map()
  for (const row of table.rows || []) {
    const extra = row.dimensionValues.filter((_, index) => index !== stepIndex).map((value) => value.value)
    if (extra.some((value) => value && value !== 'RESERVED_TOTAL')) continue
    const name = row.dimensionValues[stepIndex]?.value || ''
    if (seen.has(name)) continue
    seen.set(name, {
      users: Number(row.metricValues[usersIndex]?.value),
      abandonRate: Number(row.metricValues[abandonIndex]?.value),
    })
  }
  return [...seen.values()]
}
