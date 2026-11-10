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

/** Ask the OS for an unused port — never assume 3000/5173 are free. */
export async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      server.close((err) => {
        if (err || !port) reject(err || new Error('No free port for the app dev server'))
        else resolve(port)
      })
    })
  })
}

function portOfUrl(url) {
  try {
    const parsed = new URL(url)
    if (parsed.port) return parsed.port
    return parsed.protocol === 'https:' ? '443' : '80'
  } catch {
    return null
  }
}

function pidListeningOn(port) {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
    for (const line of out.split('\n')) {
      if (!/LISTEN/.test(line)) continue
      const pid = line.trim().split(/\s+/)[1]
      if (/^\d+$/.test(pid)) return pid
    }
  } catch {
    /* nothing listening */
  }
  return null
}

/** True when the process on this port was started from this project folder. */
function projectOwnsUrl(projectPath, url) {
  const abs = path.resolve(projectPath)
  const port = portOfUrl(url)
  if (!port) return false
  const known = existingDevUrl(abs)
  if (known && known.replace(/\/$/, '') === url.replace(/\/$/, '')) return true
  const pid = pidListeningOn(port)
  if (!pid) return false
  try {
    const cwd = execFileSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { encoding: 'utf8' })
    const dir = cwd.split('\n').find((line) => line.startsWith('n'))?.slice(1)
    if (dir && (dir === abs || dir.startsWith(`${abs}/`) || abs.startsWith(`${dir}/`))) return true
  } catch {
    /* cwd unavailable */
  }
  try {
    const cmd = execFileSync('ps', ['-p', pid, '-o', 'command='], { encoding: 'utf8' })
    if (cmd.includes(abs)) return true
  } catch {
    /* process gone */
  }
  return false
}

async function urlReady(url) {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(4000) })
    return res.status >= 100 && res.status < 500
  } catch {
    return false
  }
}

/** Candidate localhost URLs for a project folder (may include stale duplicates). */
function existingDevUrls(projectPath) {
  const abs = path.resolve(projectPath)
  const found = []
  const seen = new Set()
  const add = (url) => {
    const clean = String(url || '').replace(/\/$/, '')
    if (!clean || seen.has(clean)) return
    seen.add(clean)
    found.push(clean)
  }
  let ps = ''
  try {
    ps = execFileSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' })
  } catch {
    return found
  }
  for (const line of ps.split('\n')) {
    if (!line.includes(abs) && !line.includes(projectPath)) continue
    if (!/\b(next|vite|next-server)\b/.test(line)) continue
    const pid = line.trim().split(/\s+/)[0]
    const flagged = line.match(/(?:^|\s)(?:-p|--port)\s+(\d+)\b/)?.[1]
    if (flagged) add(`http://127.0.0.1:${flagged}`)
    try {
      const open = execFileSync('lsof', ['-nP', '-a', '-p', pid, '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' })
      for (const listen of open.split('\n')) {
        const port = listen.match(/:(\d+)\s+\(LISTEN\)/)?.[1]
        if (port) add(`http://127.0.0.1:${port}`)
      }
    } catch {
      /* the process is not listening */
    }
  }
  // Also match next-server workers whose cwd is the project (cmdline has no path).
  try {
    const listen = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' })
    for (const line of listen.split('\n')) {
      if (!/\bnode\b|\bnext\b/i.test(line)) continue
      const port = line.match(/:(\d+)\s+\(LISTEN\)/)?.[1]
      const pid = line.trim().split(/\s+/)[1]
      if (!port || !/^\d+$/.test(pid)) continue
      try {
        const cwd = execFileSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { encoding: 'utf8' })
        const dir = cwd.split('\n').find((row) => row.startsWith('n'))?.slice(1)
        if (dir && (dir === abs || dir.startsWith(`${abs}/`) || abs.startsWith(`${dir}/`))) {
          add(`http://127.0.0.1:${port}`)
        }
      } catch {
        /* cwd unavailable */
      }
    }
  } catch {
    /* lsof unavailable */
  }
  return found
}

/** A responding dev server already started for this folder. */
async function existingDevUrl(projectPath) {
  for (const url of existingDevUrls(projectPath)) {
    if (await urlReady(url)) return url
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
 * Use a URL only when it belongs to this project, otherwise start the
 * project's own dev script on a free port (never steal :3000 from another app).
 * Returns { url, owned }.
 */
export async function ensureServer(projectPath, framework, baseUrl) {
  const abs = path.resolve(projectPath)
  if (baseUrl) {
    const url = baseUrl.replace(/\/$/, '')
    // Explicit URL from the dialog / prior capture — use it when it answers.
    if (await urlReady(url)) return { url, owned: false }
  }
  const existing = running.get(abs)
  if (existing && (await urlReady(existing.url))) return existing
  const already = await existingDevUrl(abs)
  if (already) return { url: already, owned: false }

  const port = await findFreePort()
  const url = `http://127.0.0.1:${port}`
  const launch = devLaunch(abs, framework, port)
  const proc = spawn(launch.cmd, launch.args, {
    cwd: abs,
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
    if (proc.exitCode != null) {
      // Another Next for this app is often already running (lock / duplicate). Prefer it.
      const fallback = await existingDevUrl(abs)
      if (fallback) return { url: fallback, owned: false }
      const hint = /lock|already|EADDRINUSE|eslint/i.test(log)
        ? '\nIf the app is already running locally, enter its URL in FlowMap (e.g. http://127.0.0.1:4000) and map again.'
        : ''
      throw new Error(`Dev server exited.\n${log.slice(-1200)}${hint}`)
    }
    if (await urlReady(url)) {
      const handle = { url, owned: true, proc }
      running.set(abs, handle)
      return handle
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  proc.kill('SIGTERM')
  const fallback = await existingDevUrl(abs)
  if (fallback) return { url: fallback, owned: false }
  throw new Error(`Timed out waiting for ${url}.\n${log.slice(-1200)}`)
}

function joinUrl(baseUrl, route) {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  if (!route || route === '/') return base.toString()
  // Keep mounts like /ghost when the product routes are absolute (/automations).
  if (route.startsWith('/')) {
    const prefix = base.pathname.replace(/\/$/, '')
    return new URL(`${prefix}${route}`, base.origin).toString()
  }
  return new URL(route, base).toString()
}

function loginCredentials(overrides = {}) {
  return {
    email:
      overrides.email ||
      process.env.FLOWMAP_LOGIN_EMAIL ||
      process.env.FLOWMAP_FAMILYTREE_EMAIL ||
      process.env.FLOWMAP_PLANE_EMAIL ||
      process.env.FLOWMAP_GHOST_EMAIL ||
      '',
    password:
      overrides.password ||
      process.env.FLOWMAP_LOGIN_PASSWORD ||
      process.env.FLOWMAP_FAMILYTREE_PASSWORD ||
      process.env.FLOWMAP_PLANE_PASSWORD ||
      process.env.FLOWMAP_GHOST_PASSWORD ||
      '',
  }
}

function cookieHeaderList(res) {
  if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie()
  const single = res.headers.get('set-cookie')
  return single ? [single] : []
}

function cookieFromSetCookie(header, name, hostname) {
  const match = String(header || '').match(new RegExp(`${name}=([^;]+)`))
  if (!match) return null
  return { name, value: decodeURIComponent(match[1]), domain: hostname, path: '/', httpOnly: true }
}

/** Local Ghost Admin needs a staff session before Automations (and similar) will render. */
export async function localGhostCookies(baseUrl, credentials = {}) {
  let origin
  try {
    origin = new URL(baseUrl).origin
  } catch {
    return null
  }
  if (!/localhost|127\.0\.0\.1/.test(origin)) return null
  if (!String(baseUrl).includes('/ghost')) return null
  const { email, password } = loginCredentials({
    email: credentials.email || process.env.FLOWMAP_GHOST_EMAIL || 'flowmap@local.test',
    password: credentials.password || process.env.FLOWMAP_GHOST_PASSWORD || 'FlowMapLocal1!',
  })
  try {
    const res = await fetch(`${origin}/ghost/api/admin/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ username: email, password }),
      redirect: 'manual',
    })
    const header = cookieHeaderList(res)[0] || ''
    const cookie = cookieFromSetCookie(header, 'ghost-admin-api-session', new URL(origin).hostname)
    if (!cookie) return null
    return [{ ...cookie, path: '/ghost' }]
  } catch {
    return null
  }
}

/**
 * Familytree (and similar) expose POST /api/access/login → familytree_session.
 * Returns null when credentials are missing or the app is not that shape.
 */
export async function localFamilytreeCookies(baseUrl, credentials = {}) {
  let origin
  try {
    origin = new URL(baseUrl).origin
  } catch {
    return null
  }
  if (!/localhost|127\.0\.0\.1/.test(origin)) return null
  const { email, password } = loginCredentials(credentials)
  if (!email || !password) return null
  try {
    const res = await fetch(`${origin}/api/access/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, accept: 'application/json' },
      body: JSON.stringify({ email, password }),
      redirect: 'manual',
    })
    if (!res.ok) return null
    const hostname = new URL(origin).hostname
    for (const header of cookieHeaderList(res)) {
      const cookie = cookieFromSetCookie(header, 'familytree_session', hostname)
      if (cookie) return [cookie]
    }
    return null
  } catch {
    return null
  }
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

/** Fill a local email/password form when cookies could not be minted via API. */
async function loginFormIfNeeded(page, baseUrl, credentials = {}) {
  const { email, password } = loginCredentials(credentials)
  if (!email || !password) return
  const paths = ['/login', '/sign-in', '/signin', '/']
  try {
    for (const route of paths) {
      await page.goto(joinUrl(baseUrl, route), { waitUntil: 'networkidle2', timeout: 20_000 }).catch(() => null)
      const emailInput = await page.$('input[name="email"], input#email, input[type="email"]')
      const passwordInput = await page.$('input[name="password"], input#password, input[type="password"]')
      if (!emailInput || !passwordInput) continue
      await emailInput.click({ clickCount: 3 })
      await emailInput.type(email, { delay: 10 })
      await passwordInput.click({ clickCount: 3 })
      await passwordInput.type(password, { delay: 10 })
      await Promise.all([
        page.click('button[type="submit"]').catch(() => page.keyboard.press('Enter')),
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20_000 }).catch(() => {}),
      ])
      await new Promise((r) => setTimeout(r, 800))
      return
    }
  } catch {
    /* capture still proceeds; screens may show the sign-in wall */
  }
}

/** Named sizes match designer-preflight's, so screenshots line up between the two tools. */
export const VIEWPORTS = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1 },
  tablet: { width: 768, height: 1024, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  iphone: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1' },
  android: { width: 412, height: 915, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36' },
}

/** `iphone`, `android`, `tablet`, `desktop`, or `WIDTHxHEIGHT` such as `390x844`. */
export function parseViewport(value) {
  if (!value) return VIEWPORTS.desktop
  if (typeof value === 'object') return value
  if (VIEWPORTS[value]) return VIEWPORTS[value]
  const m = String(value).match(/^(\d{3,4})x(\d{3,4})$/)
  if (!m) throw new Error(`Unknown viewport "${value}". Use iphone, android, tablet, desktop or WIDTHxHEIGHT.`)
  const width = Number(m[1])
  return { width, height: Number(m[2]), deviceScaleFactor: width < 800 ? 2 : 1, isMobile: width < 800, hasTouch: width < 800 }
}

async function fillVisibleFields(page, { intent = 'valid' } = {}) {
  const fields = await page.$$('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]), textarea')
  let passwordIndex = 0
  for (const handle of fields) {
    const info = await handle.evaluate((el) => {
      const style = window.getComputedStyle(el)
      const visible = style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0
      return {
        visible,
        disabled: el.disabled || el.readOnly,
        value: el.value || '',
        type: (el.type || 'text').toLowerCase(),
        hint: `${el.name || ''} ${el.id || ''} ${el.placeholder || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase(),
      }
    })
    if (!info.visible || info.disabled) continue
    const isEmail = info.type === 'email' || info.hint.includes('email')
    const isPassword = info.type === 'password' || info.hint.includes('password')
    const isTree = /tree|title|family/.test(info.hint)
    const isYear = info.type === 'number' || /year|born|1980/.test(info.hint)
    let value = 'Alex Example'
    if (intent === 'empty') continue
    if (isEmail) {
      value = intent === 'bad-email' ? 'not-an-email' : 'flowmap.demo@example.com'
    } else if (isPassword) {
      passwordIndex += 1
      if (intent === 'short-password') value = 'short'
      else if (intent === 'mismatch' && passwordIndex > 1) value = 'DifferentPass1!'
      else value = 'FlowMapDemo1!'
    } else if (isYear) value = '1980'
    else if (isTree) value = 'The Example Family'
    else if (intent === 'empty-name') continue
    if (info.value.trim() && intent === 'valid') continue
    await handle.click({ clickCount: 3 }).catch(() => {})
    await page.keyboard.press('Backspace').catch(() => {})
    await handle.type(value, { delay: 5 })
  }
}

/** Option cards / radios used by wizards (e.g. gender) when there is no text field. */
async function pickFirstChoice(page) {
  return page.evaluate(() => {
    const labelOf = (node) => (node.innerText || node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()
    const blocked = /^(continue|next|skip|back|create account|sign up|submit|close|cancel)$/i
    const buttons = [...document.querySelectorAll('button, [role=button], [role=radio], [role=option]')]
    const choices = buttons.filter((node) => {
      if (node.disabled) return false
      const label = labelOf(node)
      if (!label || label.length > 48 || blocked.test(label)) return false
      const style = window.getComputedStyle(node)
      if (style.display === 'none' || style.visibility === 'hidden') return false
      // Prefer full-width option rows over tiny icon buttons.
      const rect = node.getBoundingClientRect()
      return rect.width >= 120 && rect.height >= 36
    })
    const want = choices[0]
    if (!want) return false
    want.click()
    return labelOf(want)
  })
}

async function clickLabeledButton(page, pattern) {
  return page.evaluate((source) => {
    const re = new RegExp(source, 'i')
    const labelOf = (node) => (node.innerText || node.value || node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()
    const buttons = [...document.querySelectorAll('button, [role=button], input[type=submit]')]
    const want = buttons.find((node) => !node.disabled && re.test(labelOf(node)))
    if (!want) return false
    want.click()
    return labelOf(want)
  }, pattern)
}

async function clickPrimaryAction(page, { allowSubmit = false } = {}) {
  return page.evaluate((allowSubmit) => {
    const labelOf = (node) => (node.innerText || node.value || node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()
    const buttons = [...document.querySelectorAll('button, [role=button], input[type=submit]')]
    const candidates = buttons.filter((node) => {
      if (node.disabled) return false
      const label = labelOf(node)
      if (!label) return false
      if (/^back$/i.test(label)) return false
      if (/continue|next|create account|sign up|get started|submit/i.test(label)) {
        if (!allowSubmit && /create account|sign up|submit/i.test(label) && !/continue|next/i.test(label)) return false
        return true
      }
      return false
    })
    const want = candidates[0]
    if (!want) return false
    want.click()
    return labelOf(want)
  }, allowSubmit)
}

function errorIntent(phrase = '') {
  const text = String(phrase).toLowerCase()
  if (/valid email|invalid email|email address/.test(text) && /valid|invalid|@/.test(text)) return 'bad-email'
  if (/don'?t match|do not match|mismatch/.test(text)) return 'mismatch'
  if (/at least|8 character|too short|short/.test(text)) return 'short-password'
  if (/password/.test(text) && /choose|enter|required|secure/.test(text)) return 'empty'
  if (/email/.test(text) && /need|required|enter/.test(text)) return 'empty'
  if (/name|call you|personalize/.test(text)) return 'empty'
  if (/consent|accept/.test(text)) return 'empty'
  return 'empty'
}

async function advanceWizardStep(page) {
  await fillVisibleFields(page, { intent: 'valid' })
  await pickFirstChoice(page)
  await new Promise((r) => setTimeout(r, 150))
  let clicked = await clickPrimaryAction(page, { allowSubmit: false })
  if (!clicked) clicked = await clickLabeledButton(page, '^skip$')
  await new Promise((r) => setTimeout(r, 700))
  return Boolean(clicked)
}

async function reachFormStage(page, stageIndex, { triggerError = false, errorPhrase = '' } = {}) {
  const target = Math.max(0, stageIndex || 0)
  for (let i = 0; i < target; i++) {
    const advanced = await advanceWizardStep(page)
    if (!advanced) break
  }
  if (triggerError) {
    const intent = errorIntent(errorPhrase)
    if (intent === 'bad-email' || intent === 'mismatch' || intent === 'short-password') {
      await fillVisibleFields(page, { intent })
    }
    await clickPrimaryAction(page, { allowSubmit: true })
    await new Promise((r) => setTimeout(r, 450))
  }
}

/** Open a same-URL overlay using labels discovered next to setShowX(true). */
async function openUiState(page, uiState = {}) {
  if (!uiState || uiState.openable === false) return false
  const labels = [...(uiState.triggers || [])]
  if (uiState.label && !labels.includes(uiState.label)) labels.push(uiState.label)
  if (uiState.id) labels.push(titleCaseWords(uiState.id))
  for (const label of labels) {
    if (!label || label.length < 2) continue
    const escaped = String(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const clicked = await clickLabeledButton(page, escaped)
    if (clicked) {
      await new Promise((r) => setTimeout(r, 600))
      return true
    }
  }
  // Soft match: any visible control whose label contains the state id tokens.
  const token = String(uiState.id || uiState.label || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .trim()
  if (token.length >= 3) {
    const clicked = await page.evaluate((needle) => {
      const words = needle.toLowerCase().split(/\s+/).filter((w) => w.length > 2)
      if (!words.length) return false
      const labelOf = (node) => (node.innerText || node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()
      const nodes = [...document.querySelectorAll('button, [role=button], a')]
      const want = nodes.find((node) => {
        if (node.disabled) return false
        const label = labelOf(node).toLowerCase()
        return words.every((w) => label.includes(w))
      })
      if (!want) return false
      want.click()
      return labelOf(want)
    }, token)
    if (clicked) {
      await new Promise((r) => setTimeout(r, 600))
      return true
    }
  }
  return false
}

function titleCaseWords(value) {
  return String(value || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function normalizeCaptureTargets(routes) {
  const out = []
  const seen = new Set()
  for (const item of routes || []) {
    const target =
      typeof item === 'string'
        ? { route: item, key: item }
        : {
            route: item.route,
            key: item.key || item.route,
            formStage: item.formStage,
            formStages: item.formStages,
            uiState: item.uiState,
            triggerError: Boolean(item.triggerError),
            errorPhrase: item.errorPhrase || item.state || '',
          }
    if (!target.route || seen.has(target.key)) continue
    seen.add(target.key)
    out.push(target)
  }
  return out
}

export async function captureRoutes(baseUrl, routes, { viewport, cookies, email, password } = {}) {
  const size = parseViewport(viewport)
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
  const linkAnchors = {}
  const targets = normalizeCaptureTargets(routes)
  try {
    const page = await browser.newPage()
    if (size.userAgent) await page.setUserAgent(size.userAgent)
    await page.setViewport({ width: size.width, height: size.height, deviceScaleFactor: size.deviceScaleFactor || 1, isMobile: Boolean(size.isMobile), hasTouch: Boolean(size.hasTouch) })
    if (cookies?.length) {
      const origin = new URL(baseUrl)
      await page.setCookie(
        ...cookies.map((cookie) => ({
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain || origin.hostname,
          path: cookie.path || '/',
          httpOnly: cookie.httpOnly !== false,
          secure: Boolean(cookie.secure),
        })),
      )
    } else {
      await loginFormIfNeeded(page, baseUrl, { email, password })
    }
    for (const target of targets) {
      const route = target.route
      try {
        const concrete = await concreteRoute(page, baseUrl, route)
        resolved[route] = concrete
        resolved[target.key] = concrete
        if (concrete.fallback) continue
        await page.goto(joinUrl(baseUrl, concrete.path), { waitUntil: 'load', timeout: 15_000 })
        await new Promise((r) => setTimeout(r, 300))
        if (target.formStage || target.triggerError) {
          await reachFormStage(page, target.formStage?.index || 0, {
            triggerError: target.triggerError,
            errorPhrase: target.errorPhrase,
          })
        } else if (target.uiState) {
          await openUiState(page, target.uiState)
        }
        const scrollHeight = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0))
        const height = Math.min(Math.max(scrollHeight, size.height), Math.round(size.height * 2.45))
        const anchors = await page.evaluate((clipHeight) => {
          const out = []
          const seen = new Set()
          for (const node of document.querySelectorAll('a[href]')) {
            const href = node.getAttribute('href') || ''
            if (!href || href.startsWith('#') || /^(mailto:|tel:|javascript:)/i.test(href)) continue
            const rect = node.getBoundingClientRect()
            if (rect.width < 2 || rect.height < 2) continue
            const y = rect.top + rect.height / 2
            if (y < 0 || y > clipHeight) continue
            let path = href
            try {
              path = href.startsWith('http') ? new URL(href).pathname : href.split(/[?#]/)[0]
            } catch {
              path = href.split(/[?#]/)[0]
            }
            if (!path) continue
            if (!path.startsWith('/')) path = `/${path}`
            if (path.length > 1) path = path.replace(/\/+$/, '')
            const key = `${path}@${Math.round(y)}`
            if (seen.has(key)) continue
            seen.add(key)
            out.push({
              path,
              y: Math.round(y),
              yRatio: Math.min(1, Math.max(0, y / clipHeight)),
              label: (node.innerText || node.getAttribute('aria-label') || '').trim().slice(0, 80),
            })
          }
          return out.slice(0, 80)
        }, height)
        const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: size.width, height }, captureBeyondViewport: true })
        images[target.key] = png
        if (target.key === route) images[route] = png
        linkAnchors[target.key] = anchors
        linkAnchors[route] = linkAnchors[route] || anchors
        if (concrete.path !== route) linkAnchors[concrete.path] = anchors
      } catch (err) {
        images[target.key] = { error: err instanceof Error ? err.message : String(err) }
      }
    }
  } finally {
    await browser.close()
  }
  return { images, resolved, linkAnchors }
}

export function projectName(projectPath, pkg) {
  return pkg.name || path.basename(projectPath)
}
