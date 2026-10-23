import http from 'node:http'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureRoutes, ensureServer, projectName } from './lib/capture.js'
import { detectAnalytics } from './lib/analytics/detect.js'
import { attachChanges } from './lib/analytics/changes.js'
import { handleAnalytics } from './lib/analytics/http.js'
import { assemble, detectFramework, mapProject } from './lib/map.js'
import { readPackage, readProject } from './lib/readProject.js'

const PORT = Number(process.env.FLOWMAP_PORT || 3920)
const HOST = '127.0.0.1'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC = path.join(ROOT, 'public')

/** Last mapped board, so the Figma plugin can pull it. */
let session = null
/** @type {Map<string, Buffer>} */
const shots = new Map()

/** A `[id]` screen the live site never links, once a real sibling address was found. */
function dropUnvisited(flow) {
  const heads = new Set(
    flow.steps.filter((step) => step.resolvedFrom).map((step) => step.resolvedFrom.split('/').filter(Boolean)[0]),
  )
  const drop = new Set(
    flow.steps
      .filter((step) => step.kind === 'happy' && step.route?.includes('[') && heads.has(step.route.split('/').filter(Boolean)[0]))
      .map((step) => step.id),
  )
  if (!drop.size) return
  for (const step of flow.steps) {
    if (step.kind === 'unhappy' && flow.edges.some((edge) => drop.has(edge.from) && edge.to === step.id)) drop.add(step.id)
  }
  for (const id of drop) {
    const incoming = flow.edges.filter((edge) => edge.to === id && !drop.has(edge.from))
    const outgoing = flow.edges.filter((edge) => edge.from === id && !drop.has(edge.to))
    for (const edge of incoming) {
      for (const out of outgoing) {
        if (!flow.edges.some((item) => item.from === edge.from && item.to === out.to)) {
          flow.edges.push({ id: `edge-${edge.from}-${out.to}`, from: edge.from, to: out.to })
        }
      }
    }
  }
  flow.steps = flow.steps.filter((step) => !drop.has(step.id))
  flow.edges = flow.edges.filter((edge) => !drop.has(edge.from) && !drop.has(edge.to))
}

function send(res, status, body, type = 'application/json') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
  res.writeHead(status, {
    'content-type': type,
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  })
  res.end(data)
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

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '')
  try {
    const url = new URL(req.url || '/', `http://${HOST}:${PORT}`)
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
      const folder = assertDir(body.path)
      const pkg = readPackage(folder)
      const files = readProject(folder)
      const framework = detectFramework(pkg, files)
      const analytics = detectAnalytics(files, folder)
      const map = mapProject(files, framework.id)
      const flows = assemble(map)
      attachChanges(folder, flows)
      const { events, ...publicAnalytics } = analytics
      session = {
        project: { path: folder, name: projectName(folder, pkg), framework: framework.name, frameworkId: framework.id, guessedUrl: framework.url, analytics: publicAnalytics },
        map,
        flows,
        events,
      }
      return send(res, 200, {
        ok: true,
        project: session.project,
        map,
        flows,
        stats: { files: Object.keys(files).length, screens: map.screens.length, links: map.links.length },
      })
    }
    if (req.method === 'POST' && url.pathname === '/api/capture') {
      const body = await readBody(req)
      if (!session) throw new Error('Map the project before capturing')
      const folder = assertDir(body.path || session.project.path)
      const framework = { id: session.project.frameworkId }
      const handle = await ensureServer(folder, framework, body.url)
      const routes = [...new Set(session.flows.flatMap((f) => f.steps.map((s) => s.route).filter(Boolean)))]
      const taken = await captureRoutes(handle.url, routes)
      let i = 0
      for (const flow of session.flows) {
        for (const step of flow.steps) {
          const original = step.route
          const concrete = taken.resolved[original]
          const shot = taken.images[original]
          if (concrete && !concrete.fallback && concrete.path !== original) {
            step.route = concrete.path
            step.resolvedFrom = original
          }
          if (Buffer.isBuffer(shot)) {
            const id = `s${++i}`
            shots.set(id, shot)
            step.shotId = id
            step.shotW = shot.readUInt32BE(16)
            step.shotH = shot.readUInt32BE(20)
            step.shotError = undefined
          } else if (shot && shot.error) {
            step.shotError = shot.error
          }
        }
        dropUnvisited(flow)
      }
      session.project.liveUrl = handle.url
      return send(res, 200, { ok: true, liveUrl: handle.url, flows: session.flows })
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
