import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WRONG_ACCOUNT } from './format.js'
import { eventRows, funnelRows, pageRows, parseReport } from './metrics.js'
import { patternToRegExp, visitsCollapsed } from './match.js'

const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly'
const home = path.join(os.homedir(), '.flowmap')

let pending = null
let rememberedSites = []

function dir() {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  return home
}

function tokenPath() {
  return path.join(dir(), 'token.json')
}

/** Google's downloaded client, or the same fields saved flat. */
export function clientFromDownload(raw) {
  let file = raw
  if (typeof raw === 'string') {
    try {
      file = JSON.parse(raw)
    } catch {
      file = null
    }
  }
  const inner = file?.installed || file?.web || file || {}
  const id = String(inner.clientId || inner.client_id || '').trim()
  const secret = String(inner.clientSecret || inner.client_secret || '').trim()
  if (!id || !secret) {
    throw new Error('That file is not a Google client. Download the JSON from the client page and choose it here.')
  }
  return { clientId: id, clientSecret: secret }
}

export function saveGoogleClient(raw) {
  const client = clientFromDownload(raw)
  fs.writeFileSync(path.join(dir(), 'client.json'), JSON.stringify(client), { mode: 0o600 })
  return client.clientId
}

export function googleClient() {
  let id = process.env.FLOWMAP_GOOGLE_CLIENT_ID || ''
  let secret = process.env.FLOWMAP_GOOGLE_CLIENT_SECRET || ''
  if (!id) {
    try {
      const saved = clientFromDownload(fs.readFileSync(path.join(home, 'client.json'), 'utf8'))
      id = saved.clientId
      secret = secret || saved.clientSecret
    } catch {
      /* no saved client */
    }
  }
  return id ? { id, secret } : null
}

function readToken() {
  try {
    return JSON.parse(fs.readFileSync(tokenPath(), 'utf8'))
  } catch {
    return null
  }
}

function writeToken(token) {
  fs.writeFileSync(tokenPath(), JSON.stringify(token), { mode: 0o600 })
}

export function clearToken() {
  try {
    fs.unlinkSync(tokenPath())
  } catch {
    /* already gone */
  }
  rememberedSites = []
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function redirectUri(port) {
  return `http://127.0.0.1:${port}/api/google/callback`
}

export function beginAuth(port) {
  const client = googleClient()
  if (!client) return { needsClient: true }
  const verifier = base64url(crypto.randomBytes(32))
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest())
  const state = base64url(crypto.randomBytes(16))
  pending = { verifier, state, at: Date.now(), redirect: redirectUri(port) }
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('client_id', client.id)
  url.searchParams.set('redirect_uri', redirectUri(port))
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', SCOPE)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent select_account')
  openBrowser(url.toString())
  return { ok: true }
}

function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  execFile(command, args, () => {})
}

async function tokenRequest(body) {
  const client = googleClient()
  const params = new URLSearchParams(body)
  params.set('client_id', client.id)
  if (client.secret) params.set('client_secret', client.secret)
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(json.error_description || json.error || 'Google did not sign in')
    err.status = res.status
    throw err
  }
  return json
}

export async function finishAuth(query) {
  if (!pending || pending.state !== query.get('state') || Date.now() - pending.at > 10 * 60 * 1000) {
    throw new Error('That sign-in expired. Connect Google again.')
  }
  if (query.get('error')) throw new Error('Google sign-in was cancelled.')
  const code = query.get('code')
  if (!code) throw new Error('Google did not return a sign-in code.')
  const redirect = pending.redirect
  const verifier = pending.verifier
  const json = await tokenRequest({
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirect,
    code_verifier: verifier,
  })
  pending = null
  const existing = readToken() || {}
  writeToken({
    ...existing,
    refresh_token: json.refresh_token || existing.refresh_token,
    access_token: json.access_token,
    expiry: Date.now() + (json.expires_in || 3600) * 1000,
    property: null,
  })
  return true
}

export async function accessToken() {
  const saved = readToken()
  if (!saved?.refresh_token) return null
  if (saved.access_token && saved.expiry > Date.now() + 60_000) return saved.access_token
  try {
    const json = await tokenRequest({ grant_type: 'refresh_token', refresh_token: saved.refresh_token })
    saved.access_token = json.access_token
    saved.expiry = Date.now() + (json.expires_in || 3600) * 1000
    if (json.refresh_token) saved.refresh_token = json.refresh_token
    writeToken(saved)
    return saved.access_token
  } catch {
    clearToken()
    return null
  }
}

async function googleJson(url, token, body) {
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(json.error?.message || `Google returned ${res.status}`)
    err.status = res.status
    throw err
  }
  return json
}

async function paged(token, url) {
  const items = []
  let pageToken = ''
  do {
    const next = new URL(url)
    if (pageToken) next.searchParams.set('pageToken', pageToken)
    const data = await googleJson(next, token)
    const key = Object.keys(data).find((name) => Array.isArray(data[name]))
    if (key) items.push(...data[key])
    pageToken = data.nextPageToken || ''
  } while (pageToken && items.length < 200)
  return items
}

function publicSite(site) {
  return { id: site.id, label: site.label, url: site.url, measurementId: site.measurementId }
}

async function listSites(token, measurementId) {
  const summaries = await paged(token, 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200')
  const properties = []
  for (const account of summaries) {
    for (const property of account.propertySummaries || []) properties.push(property)
  }
  const sites = []
  const queue = properties.slice(0, 40)
  let cursor = 0
  async function worker() {
    while (cursor < queue.length) {
      const property = queue[cursor++]
      if (measurementId && sites.some((site) => site.measurementId === measurementId)) return
      let streams = []
      try {
        streams = await paged(token, `https://analyticsadmin.googleapis.com/v1beta/${property.property}/dataStreams?pageSize=50`)
      } catch {
        continue
      }
      for (const stream of streams) {
        if (stream.type !== 'WEB_DATA_STREAM') continue
        sites.push({
          id: property.property,
          label: property.displayName || 'Untitled site',
          url: stream.webStreamData?.defaultUri || '',
          measurementId: stream.webStreamData?.measurementId || '',
        })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, () => worker()))
  rememberedSites = sites
  return sites
}

function saveProperty(site) {
  const saved = readToken() || {}
  saved.property = publicSite(site)
  writeToken(saved)
}

export function savedProperty() {
  return readToken()?.property || null
}

export function isConnected() {
  return Boolean(readToken()?.refresh_token)
}

export async function resolveProperty(measurementId) {
  const configured = Boolean(googleClient())
  const token = await accessToken()
  if (!token) return { configured, connected: false }
  const saved = readToken()?.property
  if (saved && (!measurementId || saved.measurementId === measurementId)) {
    return { configured, connected: true, property: saved }
  }
  let sites = []
  try {
    sites = await listSites(token, measurementId || null)
  } catch (err) {
    if (err.status === 401 || err.status === 403) return { configured, connected: true, message: WRONG_ACCOUNT }
    throw err
  }
  if (measurementId) {
    const match = sites.find((site) => site.measurementId === measurementId)
    if (!match) return { configured, connected: true, message: WRONG_ACCOUNT }
    saveProperty(match)
    return { configured, connected: true, property: publicSite(match) }
  }
  if (sites.length === 1) {
    saveProperty(sites[0])
    return { configured, connected: true, property: publicSite(sites[0]) }
  }
  return { configured, connected: true, needsChoice: true, sites: sites.map(publicSite) }
}

export async function chooseProperty(propertyId) {
  const token = await accessToken()
  if (!token) throw new Error('Connect Google first')
  const sites = rememberedSites.length ? rememberedSites : await listSites(token)
  const site = sites.find((item) => item.id === propertyId)
  if (!site) throw new Error('Choose a site from the list')
  saveProperty(site)
  return publicSite(site)
}

export function dimensionFilter(device, source, host) {
  const parts = []
  if (host) {
    parts.push({
      filter: { fieldName: 'hostName', stringFilter: { matchType: 'EXACT', value: host, caseSensitive: false } },
    })
  }
  if (device && device !== 'all') {
    parts.push({
      filter: { fieldName: 'deviceCategory', stringFilter: { matchType: 'EXACT', value: device, caseSensitive: false } },
    })
  }
  if (source && source !== 'all') {
    parts.push({
      filter: {
        fieldName: 'sessionDefaultChannelGroup',
        stringFilter: { matchType: 'EXACT', value: source, caseSensitive: false },
      },
    })
  }
  if (!parts.length) return undefined
  if (parts.length === 1) return parts[0]
  return { andGroup: { expressions: parts } }
}

async function runReport(token, propertyId, body) {
  return googleJson(`https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`, token, body)
}

export async function loadRange(token, propertyId, range, device, source, eventNames, host) {
  const filter = dimensionFilter(device, source, host)
  const report = await runReport(token, propertyId, {
    dateRanges: [{ startDate: range.start, endDate: range.end }],
    dimensions: [{ name: 'pagePath' }],
    metrics: [{ name: 'screenPageViews' }, { name: 'userEngagementDuration' }, { name: 'sessions' }],
    dimensionFilter: filter,
    limit: '10000',
    orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
  })
  const pages = pageRows(report)
  let summary = null
  try {
    const totals = await runReport(token, propertyId, {
      dateRanges: [{ startDate: range.start, endDate: range.end }],
      metrics: [{ name: 'sessions' }, { name: 'bounceRate' }, { name: 'averageSessionDuration' }],
      dimensionFilter: filter,
    })
    const row = parseReport(totals)[0] || {}
    summary = {
      sessions: row.sessions || 0,
      bounceRate: row.bounceRate,
      averageSessionDuration: row.averageSessionDuration || 0,
    }
  } catch {
    summary = null
  }
  let events = []
  if (eventNames.length) {
    const eventFilter = {
      filter: { fieldName: 'eventName', inListFilter: { values: eventNames.slice(0, 20), caseSensitive: true } },
    }
    const dimension = filter ? { andGroup: { expressions: [eventFilter, filter] } } : eventFilter
    try {
      const eventReport = await runReport(token, propertyId, {
        dateRanges: [{ startDate: range.start, endDate: range.end }],
        dimensions: [{ name: 'eventName' }, { name: 'pagePath' }],
        metrics: [{ name: 'eventCount' }],
        dimensionFilter: dimension,
        limit: '10000',
      })
      events = eventRows(eventReport)
    } catch {
      events = []
    }
  }
  return { pages, events, summary }
}

export async function loadFunnel(token, propertyId, range, device, source, steps) {
  if (steps.length < 2) return null
  const body = {
    dateRanges: [{ startDate: range.start, endDate: range.end }],
    dimensionFilter: dimensionFilter(device, source),
    funnel: {
      isOpenFunnel: false,
      steps: steps.map((step, index) => {
        const item = {
          name: String(step.name || 'Step').slice(0, 40),
          isDirectlyFollowedBy: false,
          filterExpression: {
            funnelFieldFilter: {
              fieldName: 'pagePath',
              stringFilter: {
                matchType: 'FULL_REGEXP',
                value: patternToRegExp(step.pattern || step.route).source,
                caseSensitive: false,
              },
            },
          },
        }
        if (index > 0) item.withinDurationFromPriorStep = '86400s'
        return item
      }),
    },
  }
  const report = await googleJson(`https://analyticsdata.googleapis.com/v1alpha/${propertyId}:runFunnelReport`, token, body)
  return funnelRows(report)
}

export function friendlyGoogleError(err) {
  if (err?.status === 401 || err?.status === 403) return WRONG_ACCOUNT
  if (err?.status === 429) return 'Google is limiting requests. Wait a minute and try again.'
  return err?.message || 'Google could not be read'
}

export { visitsCollapsed }
