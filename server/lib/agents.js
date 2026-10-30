import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runningJob, startJob } from './jobs.js'

const FLOWMAP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SDK_RUNNER = path.join(FLOWMAP_DIR, 'server', 'lib', 'cursor-sdk-run.mjs')

/**
 * Coding agents FlowMap can hand the designer-preflight skill to. Each runs headless in the
 * project folder with "--from-flowmap propose" (look and suggest, change nothing) or
 * "--from-flowmap apply" (fix only what the designer approved).
 */

function onPath(bin) {
  try {
    return execFileSync('which', [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}

function hasCursorSdk() {
  return fs.existsSync(path.join(FLOWMAP_DIR, 'node_modules', '@cursor', 'sdk', 'package.json'))
}

/** The installed skill, wherever the installer (or a checkout) put it. */
export function skillPath() {
  const candidates = [
    process.env.PREFLIGHT_DIR && path.join(process.env.PREFLIGHT_DIR, 'skill', 'designer-preflight'),
    path.join(os.homedir(), '.agents', 'skills', 'designer-preflight'),
    path.join(os.homedir(), '.claude', 'skills', 'designer-preflight'),
    path.join(os.homedir(), 'Sites', 'Preflight', 'skill', 'designer-preflight'),
  ].filter(Boolean)
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'SKILL.md'))) || null
}

export function listAgents() {
  const claude = onPath('claude')
  const codex = onPath('codex')
  const cursorCli = onPath('cursor-agent')
  const sdk = hasCursorSdk() && Boolean(process.env.CURSOR_API_KEY)
  return [
    {
      id: 'claude',
      label: 'Claude Code',
      available: Boolean(claude),
      note: claude ? '' : 'Not installed. See https://docs.claude.com/en/docs/claude-code',
    },
    {
      id: 'cursor',
      label: 'Cursor',
      available: sdk || Boolean(cursorCli),
      note: sdk ? 'Runs through the Cursor SDK' : cursorCli ? '' : 'Install the Cursor CLI (https://cursor.com/cli), or add @cursor/sdk and set CURSOR_API_KEY',
    },
    {
      id: 'codex',
      label: 'Codex',
      available: Boolean(codex),
      note: codex ? '' : 'Not installed. See https://github.com/openai/codex',
    },
  ]
}

/** Must not start with "-": the agent CLIs take the prompt as a positional argument. */
function prompt(mode, folder, skill) {
  const common = [
    `Use the designer-preflight skill. Read ${path.join(skill, 'SKILL.md')} first and follow it.`,
    `Project folder: ${folder}`,
    'FlowMap has already mapped this project\'s screens, so use --routes-from flowmap and do not start FlowMap yourself.',
  ]
  if (mode === 'propose') {
    return [
      'Run designer-preflight with --from-flowmap propose.',
      ...common,
      'Do not edit any project files. Only .preflight/ may change, and only through the skill\'s run.mjs script.',
      'Add anything the automatic checks missed, with plain-English "fix" text, then stop.',
      'Finish with a short summary a designer can read.',
    ].join('\n')
  }
  return [
    'Run designer-preflight with --from-flowmap apply.',
    ...common,
    'Fix only the finding keys listed in .preflight/approvals.json. Change nothing else.',
    'Work on a preflight/<date> branch, one commit per group of fixes, re-check each fix, and mark it fixed.',
    'Finish with a short summary a designer can read: what changed, and anything to look at on a phone.',
  ].join('\n')
}

/** Turns Claude Code and Cursor CLI stream-json lines into readable progress. */
function streamLine(line) {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    return line
  }
  if (event.type === 'assistant') {
    return (event.message?.content || [])
      .map((block) => (block.type === 'text' ? block.text : block.type === 'tool_use' ? `→ ${toolLabel(block.name, block.input)}` : ''))
      .filter(Boolean)
      .join('\n')
  }
  if (event.type === 'tool_call' && event.subtype === 'started') {
    const [name, call] = Object.entries(event.tool_call || {})[0] || []
    return name ? `→ ${toolLabel(name.replace(/ToolCall$/, ''), call?.args)}` : null
  }
  if (event.type === 'result') return event.is_error ? `Stopped: ${event.result || event.subtype}` : null
  return null
}

function toolLabel(name, input = {}) {
  const detail = input.command || input.file_path || input.path || input.pattern || ''
  return `${name}${detail ? ` ${String(detail).slice(0, 120)}` : ''}`
}

function command(agent, mode, folder, skill) {
  const text = prompt(mode, folder, skill)
  if (agent === 'claude') {
    const read = ['Read', 'Glob', 'Grep', 'Bash(node *)', 'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(npm ls*)']
    const write = ['Edit', 'Write', 'MultiEdit', 'Bash(git *)', 'Bash(npm *)', 'Bash(npx *)']
    return {
      cmd: onPath('claude'),
      args: [
        '-p', text,
        '--output-format', 'stream-json', '--verbose',
        '--permission-mode', 'dontAsk',
        '--add-dir', skill,
        '--allowedTools', ...(mode === 'apply' ? [...read, ...write] : read),
        ...(mode === 'propose' ? ['--disallowedTools', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'] : []),
      ],
      format: streamLine,
    }
  }
  if (agent === 'cursor') {
    if (hasCursorSdk() && process.env.CURSOR_API_KEY) {
      return { cmd: process.execPath, args: [SDK_RUNNER, folder, text], format: null }
    }
    return {
      cmd: onPath('cursor-agent'),
      args: ['-p', text, '--output-format', 'stream-json', '--trust', '--force', '--workspace', folder, '--add-dir', skill],
      format: streamLine,
    }
  }
  if (agent === 'codex') {
    return {
      cmd: onPath('codex'),
      args: ['exec', '--cd', folder, '--skip-git-repo-check', '--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true', text],
      format: null,
    }
  }
  return null
}

/** Project files git sees as changed, ignoring .preflight/. Null when the folder isn't a git repo. */
function changedFiles(folder) {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', '.'], { cwd: folder, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return new Set(out.split('\n').filter((line) => line.trim() && !line.slice(3).split('/').includes('.preflight')).map((line) => line.slice(3)))
  } catch {
    return null
  }
}

function approvedKeys(folder) {
  try {
    return JSON.parse(fs.readFileSync(path.join(folder, '.preflight', 'approvals.json'), 'utf8')).approved || []
  } catch {
    return []
  }
}

export function startAgent(agentId, mode, folder) {
  if (!['propose', 'apply'].includes(mode)) throw new Error('Mode must be propose or apply')
  const agent = listAgents().find((a) => a.id === agentId)
  if (!agent) throw new Error('Unknown agent')
  if (!agent.available) throw new Error(`${agent.label} isn't available. ${agent.note}`)
  const skill = skillPath()
  if (!skill) throw new Error('The Designer Preflight skill is not installed. Run `npm run install-skill` in your copy of Designer Preflight.')
  if (runningJob('agent', folder)) throw new Error('An agent is already working on this project. Wait for it to finish or stop it first.')
  if (mode === 'apply' && !approvedKeys(folder).length) throw new Error('Nothing is approved yet. Choose “Fix this” on at least one finding first.')

  const run = command(agentId, mode, folder, skill)
  const before = changedFiles(folder)
  const job = startJob('agent', run.cmd, run.args, {
    cwd: folder,
    env: { FLOWMAP_DIR, PREFLIGHT_FROM_FLOWMAP: mode },
    format: run.format,
    finish(done) {
      done.agent = agent.label
      done.mode = mode
      const after = changedFiles(folder)
      if (!before || !after) return
      const touched = [...after].filter((file) => !before.has(file))
      if (mode === 'propose' && touched.length) {
        done.warning = `The review was meant to change nothing, but these files changed: ${touched.slice(0, 8).join(', ')}${touched.length > 8 ? '…' : ''}. Check them with git before keeping them.`
      }
    },
  })
  job.agent = agent.label
  job.mode = mode
  return job
}
