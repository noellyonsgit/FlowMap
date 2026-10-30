import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startJob } from './jobs.js'

const FLOWMAP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** Which badge a finding counts towards on a screen card. */
const BADGE = { states: 'errors', health: 'errors', standards: 'access', devices: 'mobile', security: 'security', performance: 'speed', leftovers: 'tidy', docs: 'tidy' }

function onPath(bin) {
  try {
    return execFileSync('which', [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}

/** designer-preflight is optional. Look for an explicit path, the `preflight` command, then a sibling checkout. */
export function preflightCli() {
  const explicit = process.env.PREFLIGHT_BIN
  if (explicit && fs.existsSync(explicit)) return { cmd: process.execPath, args: [explicit] }
  const dir = process.env.PREFLIGHT_DIR
  if (dir && fs.existsSync(path.join(dir, 'src', 'cli.mjs'))) return { cmd: process.execPath, args: [path.join(dir, 'src', 'cli.mjs')] }
  const global = onPath('preflight')
  if (global) return { cmd: global, args: [] }
  const sibling = path.join(os.homedir(), 'Sites', 'Preflight', 'src', 'cli.mjs')
  if (fs.existsSync(sibling)) return { cmd: process.execPath, args: [sibling] }
  return null
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function parseJson(stdout) {
  const start = stdout.indexOf('{')
  if (start < 0) throw new Error('The pre-flight check did not return results')
  return JSON.parse(stdout.slice(start))
}

function cliJob(kind, args, folder) {
  const cli = preflightCli()
  if (!cli) {
    const err = new Error('Designer Preflight is not installed. Install it from https://github.com/noellyonsgit/designer-preflight, or set PREFLIGHT_DIR.')
    err.code = 'NOT_INSTALLED'
    throw err
  }
  return startJob(kind, cli.cmd, [...cli.args, ...args], { cwd: folder, env: { FLOWMAP_DIR }, parse: parseJson })
}

/** Run every automatic check, using FlowMap's own screen list. Read-only: nothing in the project changes. */
export function startScan(folder, { url } = {}) {
  return cliJob('scan', ['scan', folder, '--json', '--routes-from', 'flowmap', ...(url ? ['--url', url] : [])], folder)
}

export function startBaseline(folder, { url } = {}) {
  return cliJob('baseline', ['baseline', folder, '--json', '--routes-from', 'flowmap', ...(url ? ['--url', url] : [])], folder)
}

export function startCompare(folder, { url } = {}) {
  return cliJob('compare', ['compare', folder, '--json', ...(url ? ['--url', url] : [])], folder)
}

/** Record approve / accept-risk / reopen decisions through the CLI, so `.preflight/` has a single writer. */
export function mark(folder, keys, status, note) {
  const cli = preflightCli()
  if (!cli) throw new Error('Designer Preflight is not installed')
  const args = [...cli.args, 'mark', ...keys, '--status', status, '--project', folder, '--json', ...(note ? ['--note', note] : [])]
  return JSON.parse(execFileSync(cli.cmd, args, { encoding: 'utf8', timeout: 30_000 }))
}

/** Route or pattern a finding belongs to, matched against the board's steps. */
function routeMatches(route, step) {
  if (!route || !step.route) return false
  if (route === step.route || route === step.resolvedFrom || route === step.pattern) return true
  const want = (step.resolvedFrom || step.pattern || step.route).split('/').filter(Boolean)
  const got = route.split('/').filter(Boolean)
  return want.length === got.length && want.every((part, i) => part.startsWith('[') || part.startsWith(':') || part === got[i])
}

/** Per-screen counts for the board, plus findings that belong to no particular screen. */
export function badges(findings, flows) {
  const live = findings.filter((f) => f.status !== 'fixed' && f.status !== 'accepted-risk')
  const byStep = {}
  const placed = new Set()
  for (const flow of flows) {
    for (const step of flow.steps) {
      const counts = { errors: 0, access: 0, mobile: 0, security: 0, speed: 0, tidy: 0, worst: null, keys: [] }
      for (const f of live) {
        const routes = f.screens?.length ? f.screens : f.screen ? [f.screen] : []
        if (!routes.some((r) => routeMatches(r, step))) continue
        const badge = BADGE[f.phase] || 'tidy'
        counts[badge]++
        counts.keys.push(f.key)
        if (!counts.worst || f.severity < counts.worst) counts.worst = f.severity
        placed.add(f.key)
      }
      byStep[step.id] = counts
    }
  }
  return { byStep, sitewide: live.filter((f) => !placed.has(f.key)).map((f) => f.key) }
}

/** Everything the board needs from `.preflight/`, or `installed: false`. */
export function readState(folder, flows = []) {
  const dir = path.join(folder, '.preflight')
  const installed = Boolean(preflightCli())
  const doc = readJson(path.join(dir, 'findings.json'), null)
  if (!doc) return { ok: true, installed, scanned: false }
  const progress = readJson(path.join(dir, 'progress.json'), {})
  const diff = readJson(path.join(dir, 'diff', 'summary.json'), null)
  const live = doc.findings.filter((f) => f.status !== 'fixed')
  const blocking = live.filter((f) => f.severity === 'P0' && f.status !== 'accepted-risk')
  const risks = live.filter((f) => (f.severity === 'P1' && f.status !== 'accepted-risk') || (f.status === 'accepted-risk' && f.severity !== 'P2'))
  return {
    ok: true,
    installed,
    scanned: true,
    verdict: blocking.length ? 'NO-SHIP' : risks.length ? 'PASS WITH RISKS' : 'PASS',
    updatedAt: doc.updatedAt,
    findings: doc.findings,
    notChecked: progress.notChecked || [],
    stack: progress.stack || null,
    badges: badges(doc.findings, flows),
    baseline: fs.existsSync(path.join(dir, 'baseline', 'manifest.json')),
    diff,
  }
}

/** Only screenshots inside the project's .preflight baseline, current and diff folders may be served. */
export function screenshotPath(folder, rel) {
  const base = path.join(folder, '.preflight')
  const file = path.resolve(base, rel)
  const allowed = ['baseline', 'current', 'diff'].some((d) => file.startsWith(path.join(base, d) + path.sep))
  return allowed && file.endsWith('.png') && fs.existsSync(file) ? file : null
}
