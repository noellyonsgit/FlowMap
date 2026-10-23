import fs from 'node:fs'
import path from 'node:path'
import { analyticsLine } from './format.js'

const MEASUREMENT = /\b(G-[A-Z0-9]{6,12})\b/g
const GTM = /\b(GTM-[A-Z0-9]+)\b/g
const EVENT_RES = [
  /gtag\(\s*['"]event['"]\s*,\s*['"]([A-Za-z][\w]{0,40})['"]/g,
  /posthog\.capture\(\s*['"]([A-Za-z][\w]{0,40})['"]/g,
  /plausible\(\s*['"]([A-Za-z][\w .:-]{0,40})['"]/g,
]

function firstMatch(text, re) {
  re.lastIndex = 0
  return re.exec(text)?.[1] || null
}

function eventsIn(file, text) {
  const found = []
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    for (const re of EVENT_RES) {
      re.lastIndex = 0
      for (const match of line.matchAll(re)) {
        found.push({ name: match[1], file, line: index + 1 })
      }
    }
  })
  return found
}

function readEnvIds(root) {
  let measurementId = null
  let gtmId = null
  for (const name of ['.env', '.env.local', '.env.production', '.env.development']) {
    let text = ''
    try {
      text = fs.readFileSync(path.join(root, name), 'utf8')
    } catch {
      continue
    }
    measurementId = measurementId || firstMatch(text, MEASUREMENT)
    gtmId = gtmId || firstMatch(text, GTM)
  }
  return { measurementId, gtmId }
}

/** Measurement ID, Tag Manager container, and event names already in the project. */
export function detectAnalytics(files, root) {
  let measurementId = null
  let gtmId = null
  const events = []
  for (const [file, text] of Object.entries(files || {})) {
    if (!measurementId) measurementId = firstMatch(text, MEASUREMENT)
    if (!gtmId) gtmId = firstMatch(text, GTM)
    events.push(...eventsIn(file, text))
  }
  if (root) {
    const env = readEnvIds(root)
    measurementId = measurementId || env.measurementId
    gtmId = gtmId || env.gtmId
  }
  const analytics = { measurementId, gtmId, events }
  analytics.line = analyticsLine(analytics)
  return analytics
}

/** Event fired beside an unhappy state, when the screen records one. */
export function eventForEvidence(evidence, events) {
  const match = String(evidence || '').match(/^(.*):(\d+)$/)
  if (!match) return null
  const file = match[1]
  const line = Number(match[2])
  const nearby = (events || []).filter((event) => event.file === file && Math.abs(event.line - line) <= 40)
  nearby.sort((a, b) => Math.abs(a.line - line) - Math.abs(b.line - line))
  return nearby[0]?.name || null
}
