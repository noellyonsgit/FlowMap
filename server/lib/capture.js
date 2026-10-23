import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const running = new Map()

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean)
  return candidates.find((p) => fs.existsSync(p)) || null
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

async function findFreePort(start = 4300) {
  for (let port = start; port < start + 40; port++) {
    if (await portFree(port)) return port
  }
  throw new Error('No free port for the app dev server')
}

async function urlReady(url) {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(4000) })
    return res.status >= 100 && res.status < 500
  } catch {
    return false
  }
}

/** A dev server already started for this folder, if its port is still open. */
function existingDevUrl(projectPath) {
  let ps = ''
  try {
    ps = execFileSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' })
  } catch {
    return null
  }
  for (const line of ps.split('\n')) {
    if (!line.includes(projectPath)) continue
    if (!/\b(next|vite)\b/.test(line)) continue
    const pid = line.trim().split(/\s+/)[0]
    const flagged = line.match(/(?:^|\s)(?:-p|--port)\s+(\d+)\b/)?.[1]
    if (flagged) return `http://127.0.0.1:${flagged}`
    try {
      const open = execFileSync('lsof', ['-nP', '-a', '-p', pid, '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' })
      const port = open.match(/:(\d+)\s+\(LISTEN\)/)?.[1]
      if (port) return `http://127.0.0.1:${port}`
    } catch {
      /* the process is not listening */
    }
  }
  return null
}

/**
 * Launch the local binary. `npm exec next dev -p` is wrong here: npm treats
 * `-p` as its own package flag and Next then reads the port as a directory.
 */
function devLaunch(projectPath, framework, port) {
  const nextBin = path.join(projectPath, 'node_modules', '.bin', 'next')
  const viteBin = path.join(projectPath, 'node_modules', '.bin', 'vite')
  if (framework.id === 'next' && fs.existsSync(nextBin)) return { cmd: nextBin, args: ['dev', '-p', String(port), '-H', '127.0.0.1'] }
  if (fs.existsSync(viteBin)) return { cmd: viteBin, args: ['--port', String(port), '--strictPort', '--host', '127.0.0.1'] }
  return { cmd: 'npm', args: ['run', 'dev', '--', '--port', String(port), '--host', '127.0.0.1'] }
}

/**
 * Use a URL the user already has running, or start the project's dev script.
 * Returns { url, owned }.
 */
export async function ensureServer(projectPath, framework, baseUrl) {
  if (baseUrl) {
    const url = baseUrl.replace(/\/$/, '')
    if (!(await urlReady(url))) throw new Error(`Nothing is responding at ${url}`)
    return { url, owned: false }
  }
  const existing = running.get(projectPath)
  if (existing && (await urlReady(existing.url))) return existing
  const already = existingDevUrl(projectPath)
  if (already && (await urlReady(already))) return { url: already, owned: false }

  const port = await findFreePort()
  const url = `http://127.0.0.1:${port}`
  const launch = devLaunch(projectPath, framework, port)
  const proc = spawn(launch.cmd, launch.args, {
    cwd: projectPath,
    env: { ...process.env, PORT: String(port), BROWSER: 'none' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  const push = (buf) => {
    log += buf.toString()
    if (log.length > 8000) log = log.slice(-8000)
  }
  proc.stdout?.on('data', push)
  proc.stderr?.on('data', push)
  const started = Date.now()
  while (Date.now() - started < 90_000) {
    if (proc.exitCode != null) throw new Error(`Dev server exited.\n${log.slice(-1200)}`)
    if (await urlReady(url)) {
      const handle = { url, owned: true, proc }
      running.set(projectPath, handle)
      return handle
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  proc.kill('SIGTERM')
  throw new Error(`Timed out waiting for ${url}.\n${log.slice(-1200)}`)
}

function joinUrl(baseUrl, route) {
  return new URL(route === '/' ? '/' : route, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString()
}

function linkMatches(route, href) {
  const wanted = route.split('/').filter(Boolean)
  const parts = href.split('?')[0].split('/').filter(Boolean)
  return parts.length === wanted.length && wanted.every((part, i) => part.startsWith('[') || part.toLowerCase() === parts[i]?.toLowerCase())
}

/** `/prints/q/[slug]` has no slug in the source. Use a link a parent page actually renders. */
async function concreteRoute(page, baseUrl, route) {
  if (!route.includes('[')) return { path: route, fallback: false }
  let parent = route.replace(/\/\[[^\]]+\]/g, '') || '/'
  const tried = new Set()
  while (!tried.has(parent)) {
    tried.add(parent)
    try {
      await page.goto(joinUrl(baseUrl, parent), { waitUntil: 'load', timeout: 15_000 })
      const hrefs = await page.$$eval('a[href]', (nodes) => nodes.map((node) => node.getAttribute('href') || ''))
      const hit = hrefs.find((href) => linkMatches(route, href))
      if (hit) {
        const path = hit.startsWith('http') ? new URL(hit).pathname : hit.split('?')[0]
        return { path, fallback: false }
      }
    } catch {
      /* try the directory above */
    }
    if (parent === '/') break
    parent = parent.replace(/\/[^/]+$/, '') || '/'
  }
  return { path: route, fallback: true }
}

export async function captureRoutes(baseUrl, routes) {
  const executablePath = chromePath()
  if (!executablePath) throw new Error('Google Chrome was not found. Install Chrome or set CHROME_PATH.')
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    timeout: 20_000,
    args: ['--disable-gpu', '--no-first-run'],
  })
  const images = {}
  const resolved = {}
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
    for (const route of [...new Set(routes)]) {
      try {
        const concrete = await concreteRoute(page, baseUrl, route)
        resolved[route] = concrete
        if (concrete.fallback) continue
        await page.goto(joinUrl(baseUrl, concrete.path), { waitUntil: 'load', timeout: 15_000 })
        await new Promise((r) => setTimeout(r, 300))
        const scrollHeight = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0))
        const height = Math.min(Math.max(scrollHeight, 900), 2200)
        const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1440, height } })
        images[route] = png
      } catch (err) {
        images[route] = { error: err instanceof Error ? err.message : String(err) }
      }
    }
  } finally {
    await browser.close()
  }
  return { images, resolved }
}

export function projectName(projectPath, pkg) {
  return pkg.name || path.basename(projectPath)
}
