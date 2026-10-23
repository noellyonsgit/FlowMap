import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { isoDay } from './windows.js'

const MERGE = /^merge\b/i

export function parseChangelog(text) {
  const releases = []
  let current = null
  const flush = () => {
    if (current?.date && current.title) releases.push({ date: current.date, title: current.title })
  }
  for (const line of String(text || '').split('\n')) {
    const heading = line.match(/^#{1,2}\s+(.+?)\s*$/)
    if (heading) {
      flush()
      const date = heading[1].match(/(\d{4}-\d{2}-\d{2})/)?.[1] || null
      const title = heading[1]
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/\d{4}-\d{2}-\d{2}/g, ' ')
        .replace(/\bv?\d+\.\d+\.\d+\b/g, ' ')
        .replace(/[-–—]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      current = { date, title: title.length > 2 ? cap(title) : '' }
      continue
    }
    if (current?.date && !current.title) {
      const bullet = line.match(/^\s*[-*]\s+(.+)/)
      if (bullet) current.title = cap(bullet[1].replace(/[`*]/g, '').trim().slice(0, 80))
    }
  }
  flush()
  return releases
}

function cap(value) {
  if (!value) return value
  return value.charAt(0).toUpperCase() + value.slice(1)
}

export function plainSubject(subject) {
  const tidy = String(subject || '')
    .replace(/^(feat|fix|chore|docs|style|refactor|perf|test)(\([^)]+\))?!?:\s*/i, '')
    .trim()
  return cap(tidy || String(subject || '').trim())
}

export function parseGitLog(text) {
  return String(text || '')
    .split(/^---$/m)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [hash, date, subject, ...files] = chunk.split('\n')
      return { hash: hash?.trim(), date: date?.trim(), subject: subject?.trim() || '', files: files.map((file) => file.trim()).filter(Boolean) }
    })
    .filter((commit) => /^[0-9a-f]{7,}$/i.test(commit.hash || '') && /^\d{4}-\d{2}-\d{2}$/.test(commit.date || ''))
}

function nameFor(commits, release) {
  if (release?.title) return release.title
  const usable = commits.find((commit) => commit.subject && !MERGE.test(commit.subject))
  return plainSubject(usable?.subject || commits[0]?.subject || 'Update')
}

export function groupCommits(commits, releases) {
  const byDay = new Map()
  for (const commit of commits) {
    if (!byDay.has(commit.date)) byDay.set(commit.date, [])
    byDay.get(commit.date).push(commit)
  }
  const days = [...byDay.keys()].sort((a, b) => b.localeCompare(a))
  return days.slice(0, 8).map((day) => {
    const group = byDay.get(day)
    const release = releases.find((item) => item.date === day)
    return {
      id: `c-${day}`,
      name: nameFor(group, release),
      day,
      at: day,
      source: release ? 'release' : 'commit',
      shas: group.map((commit) => commit.hash),
    }
  })
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: 8000,
    maxBuffer: 2_000_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

function readChangelog(root) {
  for (const name of ['CHANGELOG.md', 'CHANGELOG', 'HISTORY.md', 'docs/CHANGELOG.md']) {
    try {
      return parseChangelog(fs.readFileSync(path.join(root, name), 'utf8'))
    } catch {
      /* missing */
    }
  }
  return []
}

function githubRepo(root) {
  try {
    const url = git(root, ['remote', 'get-url', 'origin']).trim()
    const match = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/)
    return match ? `${match[1]}/${match[2]}` : null
  } catch {
    return null
  }
}

function productionDeploys(repo) {
  try {
    const out = execFileSync(
      'gh',
      ['api', `repos/${repo}/deployments?per_page=20`, '--jq', '.[] | [.sha, .created_at, .environment] | @tsv'],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 1_000_000, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    return out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, at, environment] = line.split('\t')
        return { sha, at, environment }
      })
      .filter((deploy) => /production/i.test(deploy.environment || '') && deploy.sha && deploy.at)
  } catch {
    return []
  }
}

function containsCommit(root, commit, tip) {
  if (!commit || !tip) return false
  if (commit === tip) return true
  try {
    execFileSync('git', ['-C', root, 'merge-base', '--is-ancestor', commit, tip], { stdio: 'ignore', timeout: 4000 })
    return true
  } catch {
    return false
  }
}

function applyDeploys(root, changes, deploys) {
  if (!deploys.length) return changes
  const ordered = [...deploys].sort((a, b) => a.at.localeCompare(b.at))
  return changes.map((change) => {
    const sha = change.shas[0]
    const deploy = ordered.find((item) => isoDay(item.at) >= change.day && containsCommit(root, sha, item.sha))
    if (!deploy) return change
    return { ...change, at: deploy.at, day: isoDay(deploy.at), source: 'deploy' }
  })
}

function filesFor(flow) {
  return [...new Set(flow.steps.map((step) => step.entry).filter(Boolean))]
}

function logFor(root, files) {
  if (!files.length) return []
  try {
    const text = git(root, [
      'log',
      '-n',
      '200',
      '--since=180.days.ago',
      '--date=short',
      '--pretty=format:---%n%H%n%ad%n%s',
      '--name-only',
      '--',
      ...files,
    ])
    return parseGitLog(text)
  } catch {
    return []
  }
}

/** Named changes for each journey, from the files that journey already uses. */
export function attachChanges(root, flows) {
  const releases = readChangelog(root)
  let deploys = []
  const repo = githubRepo(root)
  if (repo) deploys = productionDeploys(repo)
  for (const flow of flows) {
    const commits = logFor(root, filesFor(flow))
    flow.changes = applyDeploys(root, groupCommits(commits, releases), deploys).map(({ shas: _shas, ...change }) => change)
  }
  return flows
}
