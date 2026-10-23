import { eventForEvidence } from './detect.js'
import {
  accessToken,
  beginAuth,
  chooseProperty,
  clearToken,
  finishAuth,
  friendlyGoogleError,
  googleClient,
  isConnected,
  saveGoogleClient,
  loadRange,
  redirectUri,
  resolveProperty,
  savedProperty,
} from './google.js'
import { siteHost } from './match.js'
import { describeFlow, rangeFor } from './metrics.js'

function page(title, message) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #eef2f6; color: #15202b; font-family: system-ui, sans-serif; }
      main { max-width: 420px; padding: 32px; }
      h1 { font-size: 22px; font-weight: 600; letter-spacing: -0.02em; margin: 0 0 8px; }
      p { margin: 0; color: #475569; line-height: 1.45; }
    </style>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <p>${message}</p>
    </main>
  </body>
</html>`
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
}

async function sharedRange(cache, token, propertyId, range, device, source, names, host) {
  if (!range) return null
  const key = `${range.start}:${range.end}:${device}:${source}:${host || ''}`
  if (!cache.has(key)) cache.set(key, loadRange(token, propertyId, range, device, source, names, host))
  return cache.get(key)
}

export async function loadBoard(session, body = {}) {
  const measurementId = session?.project?.analytics?.measurementId || ''
  const resolved = await resolveProperty(measurementId)
  if (!resolved.connected) {
    const err = new Error('Connect Google to read visits')
    err.code = 'CONNECT'
    throw err
  }
  if (resolved.message && !resolved.property) {
    const err = new Error(resolved.message)
    err.code = 'ACCOUNT'
    throw err
  }
  if (!resolved.property) return { needsChoice: true, sites: resolved.sites || [] }

  const token = await accessToken()
  const today = new Date()
  const events = session.events || []
  const names = []
  for (const flow of session.flows) {
    for (const step of flow.steps) {
      if (step.kind !== 'unhappy') continue
      const name = eventForEvidence(step.evidence, events)
      if (name && !names.includes(name)) names.push(name)
    }
  }
  const device = body.device || 'all'
  const source = body.source || 'all'
  const host = siteHost(resolved.property.url)
  const plans = session.flows.map((flow) => rangeFor(flow, body.changes?.[flow.id], today))
  const cache = new Map()
  const packs = await Promise.all(
    plans.map(async (plan) => ({
      current: await sharedRange(cache, token, resolved.property.id, plan.current, device, source, names, host),
      before: await sharedRange(cache, token, resolved.property.id, plan.before, device, source, names, host),
    })),
  )

  const flows = []
  for (let index = 0; index < session.flows.length; index++) {
    const flow = session.flows[index]
    const plan = plans[index]
    const current = packs[index].current || { pages: [], events: [], summary: null }
    const before = packs[index].before
    flows.push(
      describeFlow(
        flow,
        { pages: current.pages, events: current.events, summary: current.summary },
        before ? { pages: before.pages, events: before.events, summary: before.summary } : null,
        {
          today,
          change: plan.change,
          events,
          deployed: plan.change?.source === 'deploy',
        },
      ),
    )
  }
  return { property: resolved.property, flows }
}

export async function handleAnalytics(req, res, url, ctx) {
  const { send, readBody, getSession, port } = ctx

  if (req.method === 'GET' && url.pathname === '/api/google/status') {
    return send(res, 200, {
      ok: true,
      configured: Boolean(googleClient()),
      connected: isConnected(),
      property: savedProperty(),
      redirect: redirectUri(port),
    })
  }
  if (req.method === 'POST' && url.pathname === '/api/google/client') {
    const body = await readBody(req)
    try {
      saveGoogleClient(body.client ?? body)
      return send(res, 200, { ok: true, configured: true, redirect: redirectUri(port) })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not save that client'
      return send(res, 200, { ok: false, error: message })
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/google/start') {
    const started = beginAuth(port)
    if (started.needsClient) return send(res, 200, { ok: true, needsClient: true, redirect: redirectUri(port) })
    return send(res, 200, started)
  }
  if (req.method === 'GET' && url.pathname === '/api/google/callback') {
    try {
      await finishAuth(url.searchParams)
      return send(res, 200, page('Connected', 'FlowMap can read visits. You can close this tab.'), 'text/html; charset=utf-8')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Google sign-in failed'
      return send(res, 200, page('Could not connect', escapeHtml(message)), 'text/html; charset=utf-8')
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/google/resolve') {
    const session = getSession()
    try {
      const resolved = await resolveProperty(session?.project?.analytics?.measurementId || '')
      if (resolved.message && !resolved.property) return send(res, 200, { ok: false, error: resolved.message })
      return send(res, 200, { ok: true, ...resolved, configured: Boolean(googleClient()) })
    } catch (err) {
      return send(res, 200, { ok: false, error: friendlyGoogleError(err) })
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/google/choose') {
    const body = await readBody(req)
    const property = await chooseProperty(body.property)
    return send(res, 200, { ok: true, property })
  }
  if (req.method === 'POST' && url.pathname === '/api/google/disconnect') {
    clearToken()
    return send(res, 200, { ok: true })
  }
  if (req.method === 'POST' && url.pathname === '/api/metrics') {
    const session = getSession()
    if (!session?.flows?.length) throw new Error('Map a project first')
    const body = await readBody(req)
    try {
      const board = await loadBoard(session, body)
      if (board.needsChoice) return send(res, 200, { ok: true, needsChoice: true, sites: board.sites })
      return send(res, 200, { ok: true, ...board })
    } catch (err) {
      if (err.code === 'CONNECT' || err.code === 'ACCOUNT') return send(res, 200, { ok: false, error: err.message })
      return send(res, 200, { ok: false, error: friendlyGoogleError(err) })
    }
  }
  return false
}