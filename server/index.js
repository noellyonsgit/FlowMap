import http from 'node:http'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listAgents, skillPath, startAgent } from './lib/agents.js'
import { handleAnalytics } from './lib/analytics/http.js'
import { cancelJob, getJob } from './lib/jobs.js'
import { captureFlows, mapFolder } from './lib/pipeline.js'
import { mark, readState, screenshotPath, startBaseline, startCompare, startScan } from './lib/preflight.js'

const PORT = Number(process.env.FLOWMAP_PORT || 3920)
const HOST = '127.0.0.1'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC = path.join(ROOT, 'public')

/** Last mapped board, so the Figma plugin can pull it. */
let session = null
/** @type {Map<string, Buffer>} */
const shots = new Map()

function send(res, status, body, type = 'application/json') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
  })
  res.end(data)
}

const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`])
const ORIGINS = new Set([...HOSTS].map((host) => `http://${host}`))

/** The Figma plugin reads from a sandbox whose origin is `null`. */
function figmaRead(req, url) {
  return req.method === 'GET' && (url.pathname === '/api/figma' || url.pathname.startsWith('/shots/'))
}

/**
 * Any page open in the browser can send requests to this port. Only FlowMap's own
 * page, the Figma plugin, and non-browser callers may use it; a Host check stops
 * DNS rebinding.
 */
function allowed(req, url) {
  if (!HOSTS.has(req.headers.host || '')) return false
  const origin = req.headers.origin
  if (!origin || ORIGINS.has(origin)) return true
  return origin === 'null' && figmaRead(req, url)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function assertDir(input) {
  if (!input || typeof input !== 'string') throw new Error('Choose a project folder first')
  const resolved = path.resolve(input)
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error(`Not a folder: ${resolved}`)
  return resolved
}

function pickFolder() {
  if (process.platform !== 'darwin') throw new Error('Folder picker is built for macOS. Paste the absolute path instead.')
  const out = execFileSync('osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose the app to map")'], {
    encoding: 'utf8',
    timeout: 300_000,
  }).trim()
  if (!out) {
    const err = new Error('Cancelled')
    err.code = 'CANCELLED'
    throw err
  }
  return assertDir(out.replace(/\/$/, ''))
}

function publicFile(urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
  const file = path.normalize(path.join(PUBLIC, rel))
  if (!file.startsWith(PUBLIC)) return null
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null
  return file
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' }

function figmaDoc() {
  if (!session) return { ok: false, error: 'Map a project in FlowMap first' }
  const flow = session.flows.find((f) => f.id === session.activeId) ?? session.flows[0]
  return {
    ok: true,
    name: session.project.name,
    lanes: flow.lanes.map((lane) => ({
      ...lane,
      steps: flow.steps
        .filter((s) => s.laneId === lane.id)
        .sort((a, b) => a.col - b.col)
        .map((s) => ({
          ...s,
          image: s.shotId ? `http://${HOST}:${PORT}/shots/${s.shotId}` : null,
        })),
    })),
    edges: flow.edges,
  }
}

/** Pre-flight checks run by Designer Preflight, shown on the board. FlowMap never edits the project itself. */
async function handlePreflight(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/jobs') {
    const job = getJob(url.searchParams.get('id') || '')
    return job ? send(res, 200, { ok: true, job }) : send(res, 404, { ok: false, error: 'No such job' })
  }
  if (req.method === 'POST' && url.pathname === '/api/jobs/cancel') {
    const body = await readBody(req)
    return send(res, 200, { ok: cancelJob(body.id) })
  }
  if (req.method === 'GET' && url.pathname === '/api/agents') return send(res, 200, { ok: true, agents: listAgents(), skill: Boolean(skillPath()) })
  if (!session) throw new Error('Map a project in FlowMap first')
  const folder = session.project.path
  if (req.method === 'POST' && url.pathname === '/api/agents/run') {
    const body = await readBody(req)
    const job = startAgent(body.agent, body.mode, folder)
    return send(res, 200, { ok: true, jobId: job.id })
  }
  if (req.method === 'GET' && url.pathname === '/api/preflight') return send(res, 200, readState(folder, session.flows))
  if (req.method === 'GET' && url.pathname === '/api/preflight/shot') {
    const file = screenshotPath(folder, url.searchParams.get('path') || '')
    return file ? send(res, 200, fs.readFileSync(file), 'image/png') : send(res, 404, { ok: false, error: 'Screenshot not found' })
  }
  if (req.method === 'POST') {
    const body = await readBody(req)
    const liveUrl = body.url || session.project.liveUrl
    const start = { '/api/preflight/scan': startScan, '/api/preflight/baseline': startBaseline, '/api/preflight/compare': startCompare }[url.pathname]
    if (start) {
      try {
        const job = start(folder, { url: liveUrl })
        return send(res, 200, { ok: true, jobId: job.id })
      } catch (err) {
        if (err.code === 'NOT_INSTALLED') return send(res, 200, { ok: false, notInstalled: true, error: err.message })
        throw err
      }
    }
    if (url.pathname === '/api/preflight/mark') {
      if (!Array.isArray(body.keys) || !['approved', 'accepted-risk', 'open'].includes(body.status)) throw new Error('Choose findings and a decision')
      return send(res, 200, { ok: true, ...mark(folder, body.keys, body.status, body.note) })
    }
  }
  return send(res, 404, { ok: false, error: 'Not found' })
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${HOST}:${PORT}`)
    if (!allowed(req, url)) return send(res, 403, { ok: false, error: 'Request blocked' })
    if (req.method === 'OPTIONS') return send(res, 204, '')
    if (figmaRead(req, url)) res.setHeader('access-control-allow-origin', '*')
    if ((await handleAnalytics(req, res, url, { send, readBody, getSession: () => session, port: PORT })) !== false) return
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true })
    if (req.method === 'GET' && url.pathname === '/api/figma') return send(res, 200, figmaDoc())
    if (req.method === 'POST' && url.pathname === '/api/active') {
      const body = await readBody(req)
      if (session) session.activeId = body.id
      return send(res, 200, { ok: true })
    }
    if (req.method === 'GET' && url.pathname.startsWith('/shots/')) {
      const buf = shots.get(url.pathname.slice('/shots/'.length))
      if (!buf) return send(res, 404, { ok: false, error: 'Shot not found' })
      return send(res, 200, buf, 'image/png')
    }
    if (req.method === 'POST' && url.pathname === '/api/pick') {
      try {
        const folder = pickFolder()
        return send(res, 200, { ok: true, path: folder })
      } catch (err) {
        if (err && err.code === 'CANCELLED') return send(res, 200, { ok: false, cancelled: true })
        throw err
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/map') {
      const body = await readBody(req)
      const { stats, ...mapped } = mapFolder(assertDir(body.path))
      session = mapped
      return send(res, 200, { ok: true, project: session.project, map: session.map, flows: session.flows, stats })
    }
    if (req.method === 'POST' && url.pathname === '/api/capture') {
      const body = await readBody(req)
      if (!session) throw new Error('Map the project before capturing')
      const project = { ...session.project, path: assertDir(body.path || session.project.path) }
      let i = 0
      const { liveUrl } = await captureFlows(project, session.flows, {
        url: body.url,
        onShot: (_step, png) => {
          const id = `s${++i}`
          shots.set(id, png)
          return id
        },
      })
      session.project.liveUrl = liveUrl
      return send(res, 200, { ok: true, liveUrl, flows: session.flows })
    }

    if (['/api/preflight', '/api/jobs', '/api/agents'].some((prefix) => url.pathname.startsWith(prefix))) {
      return await handlePreflight(req, res, url)
    }

    const file = req.method === 'GET' ? publicFile(url.pathname) : null
    if (file) return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream')
    send(res, 404, { ok: false, error: 'Not found' })
  } catch (err) {
    if (!res.headersSent) send(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`[flowmap] http://${HOST}:${PORT}`)
})
