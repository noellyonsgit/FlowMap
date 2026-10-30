import { spawn } from 'node:child_process'

/** Long-running child processes (pre-flight scans, agent runs) the UI polls for progress. */
const jobs = new Map()
let next = 0

/**
 * `parse` turns the whole of stdout into the job result. Without it, stdout goes to the log,
 * passed line by line through `format` when given (return null to drop a line).
 * `finish` runs after a clean exit and may add a note or warning to the job.
 */
export function startJob(kind, cmd, args, { cwd, env, parse, format, finish } = {}) {
  const id = `${kind}-${++next}`
  const job = { id, kind, cwd, status: 'running', log: '', startedAt: Date.now(), result: null, error: null, warning: null }
  jobs.set(id, job)
  let stdout = ''
  let partial = ''
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  job.child = child
  const append = (text) => {
    job.log = (job.log + text).slice(-20_000)
  }
  const formatLines = (text, flush) => {
    const lines = (partial + text).split('\n')
    partial = flush ? '' : lines.pop()
    for (const line of lines) {
      const out = line.trim() ? format(line) : null
      if (out) append(out.endsWith('\n') ? out : `${out}\n`)
    }
  }
  child.stdout.on('data', (buf) => {
    const text = buf.toString()
    stdout += text
    if (parse) return
    if (format) formatLines(text, false)
    else append(text)
  })
  child.stderr.on('data', (buf) => append(buf.toString()))
  child.on('error', (err) => {
    job.status = 'failed'
    job.error = err.message
  })
  child.on('close', (code) => {
    job.child = null
    job.finishedAt = Date.now()
    if (format && partial) formatLines('', true)
    if (job.status === 'cancelled') return
    try {
      job.result = parse ? parse(stdout) : stdout.slice(-20_000)
      job.status = code === 0 || (parse && job.result) ? 'done' : 'failed'
      if (job.status === 'failed') job.error = job.log.trim().split('\n').slice(-3).join('\n') || `Exited with code ${code}`
      if (finish) finish(job)
    } catch (err) {
      job.status = 'failed'
      job.error = `${err.message}\n${job.log.trim().split('\n').slice(-3).join('\n')}`
    }
  })
  return job
}

export function getJob(id) {
  const job = jobs.get(id)
  if (!job) return null
  const { child: _child, ...rest } = job
  return rest
}

export function runningJob(kind, cwd) {
  for (const job of jobs.values()) if (job.kind === kind && job.cwd === cwd && job.status === 'running') return job
  return null
}

export function cancelJob(id) {
  const job = jobs.get(id)
  if (!job?.child) return false
  job.status = 'cancelled'
  job.child.kill('SIGTERM')
  return true
}
