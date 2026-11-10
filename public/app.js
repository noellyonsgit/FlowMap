import { badgeHeight, badgeRow, initPreflight, loadPreflight, resetPreflight } from './preflight.js?v=1'

const pathInput = document.querySelector('#path')
const appUrlInput = document.querySelector('#app-url')
const loginEmailInput = document.querySelector('#login-email')
const loginPasswordInput = document.querySelector('#login-password')
const statusEl = document.querySelector('#status')
const dialogStatus = document.querySelector('#dialog-status')
const board = document.querySelector('#board')
const empty = document.querySelector('#empty')
const projectBtn = document.querySelector('#project')
const openDialog = document.querySelector('#open-project')
const mapBtn = document.querySelector('#map')

try {
  const savedLogin = JSON.parse(sessionStorage.getItem('flowmap-login') || 'null')
  if (savedLogin?.email && loginEmailInput) loginEmailInput.value = savedLogin.email
  const savedAppUrl = sessionStorage.getItem('flowmap-app-url')
  if (savedAppUrl && appUrlInput) appUrlInput.value = savedAppUrl
} catch {
  /* ignore */
}
const openSiteBtn = document.querySelector('#open-site')
const pdfBtn = document.querySelector('#pdf')
const figmaBtn = document.querySelector('#figma')
const help = document.querySelector('#figma-help')
const viewer = document.querySelector('#viewer')
const doc = document.querySelector('#doc')
const visits = document.querySelector('#visits')
const visitsToggle = document.querySelector('#visits-toggle')
const visitsPanel = document.querySelector('#visits-panel')

let session = null
let activeId = null
let metricsBoard = null
let googleStatus = { configured: false, connected: false, property: null, redirect: '' }
let choices = { device: 'all', source: 'all', changes: {} }
let connectPoll = null
let capturing = false

const connectBtn = document.querySelector('#connect')
const switchBtn = document.querySelector('#switch-account')
const deviceSelect = document.querySelector('#device')
const sourceSelect = document.querySelector('#source')

const LABEL_W = 168
const CARD_W = 280
const COL_GAP = 64
const ZOOM_MIN = 0.15
const ZOOM_MAX = 1.6
const zoomBar = document.querySelector('#zoom')
const zoomOutBtn = document.querySelector('#zoom-out')
const zoomInBtn = document.querySelector('#zoom-in')
const zoomFitBtn = document.querySelector('#zoom-fit')
const zoomLevel = document.querySelector('#zoom-level')
let zoom = 1
let userZoom = false
let mapFlow = null

function setStatus(text, error = false, action = null) {
  statusEl.replaceChildren()
  statusEl.classList.toggle('error', Boolean(error))
  statusEl.hidden = !text
  if (!text) return
  statusEl.append(document.createTextNode(text))
  if (action?.label && typeof action.onClick === 'function') {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'status-action'
    button.textContent = action.label
    button.onclick = (event) => {
      event.preventDefault()
      action.onClick()
    }
    statusEl.append(document.createTextNode(' · '), button)
  }
}

function setDialogStatus(text, error = false) {
  dialogStatus.textContent = text || ''
  dialogStatus.classList.toggle('error', error)
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const json = await res.json()
  if (!res.ok || json.ok === false) {
    if (json.cancelled) return json
    throw new Error(json.error || `Request failed (${res.status})`)
  }
  return json
}

const EDGE_COLOR = { happy: '#15202b', unhappy: '#c2410c', edge: '#b45309', variant: '#475569', overlay: '#0f766e' }
const linkTip = document.querySelector('#link-tip')

function mapLinkSources(fromStep, toStep) {
  const links = session?.map?.links || []
  if (!fromStep || !toStep) return []
  return links
    .filter((link) => link.from === fromStep.name && link.to === toStep.name)
    .map((link) => ({
      context: link.context || '',
      conditional: Boolean(link.conditional),
    }))
}

function hideLinkTip() {
  if (!linkTip) return
  linkTip.hidden = true
  linkTip.replaceChildren()
}

function showLinkTip(event, payload) {
  if (!linkTip) return
  linkTip.replaceChildren()
  linkTip.append(el('strong', null, payload.title))
  if (payload.route) linkTip.append(el('p', 'tip-route', payload.route))
  for (const source of payload.sources || []) {
    const line = source.context
      ? `${source.conditional ? 'Branch · ' : ''}${source.context}`
      : source.conditional
        ? 'Conditional link in the code'
        : 'Link found in the code'
    linkTip.append(el('p', 'tip-source', line))
  }
  if (!(payload.sources || []).length) {
    linkTip.append(el('p', 'tip-source', 'No single control pinned yet — this is the page-to-page path.'))
  }
  linkTip.append(el('p', 'tip-note', payload.note))
  linkTip.hidden = false
  const pad = 14
  const width = linkTip.offsetWidth || 280
  const height = linkTip.offsetHeight || 120
  const left = Math.min(window.innerWidth - width - pad, Math.max(pad, event.clientX + 14))
  const top = Math.min(window.innerHeight - height - pad, Math.max(pad, event.clientY + 14))
  linkTip.style.left = `${left}px`
  linkTip.style.top = `${top}px`
}

function attachCountTip(group, flow, from, to, clicks, kind) {
  const sources = mapLinkSources(from, to)
  const shot = findShotAnchor(from, to)
  if (shot?.label && !sources.some((item) => item.context.includes(shot.label))) {
    sources.unshift({ context: `On screen: “${shot.label}”`, conditional: false })
  } else if (shot && !sources.length) {
    sources.push({ context: shot.label ? `On screen: “${shot.label}”` : 'Matched a link on the screenshot', conditional: false })
  }
  const title = clicks === 1 ? '1 visit followed this path' : `${clicks.toLocaleString('en-GB')} visits followed this path`
  const route = `${from.route || from.name} → ${to.route || to.name}`
  const note = kind === 'link'
    ? 'Extra page link under the main journey. Counts come from Analytics page referrers, not the exact button.'
    : 'Main journey step. Counts come from Analytics page referrers, not the exact button.'
  group.addEventListener('pointerenter', (event) => showLinkTip(event, { title, route, sources, note }))
  group.addEventListener('pointermove', (event) => {
    if (linkTip?.hidden) return
    showLinkTip(event, { title, route, sources, note })
  })
  group.addEventListener('pointerleave', hideLinkTip)
}

function countBadge(svg, mid, clicks, meta) {
  const group = document.createElementNS('http://www.w3.org/2000/svg', 'g')
  group.setAttribute('class', 'link-hit')
  group.dataset.from = meta.from
  group.dataset.to = meta.to
  group.dataset.linkLabel = '1'
  if (meta.bow != null) group.dataset.bow = String(meta.bow)
  if (meta.link) group.dataset.link = '1'
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
  bg.setAttribute('class', 'link-count-bg')
  bg.setAttribute('cx', String(mid.x))
  bg.setAttribute('cy', String(mid.y))
  bg.setAttribute('r', clicks > 99 ? '14' : '11')
  const label = document.createElementNS('http://www.w3.org/2000/svg', 'text')
  label.setAttribute('class', 'link-count')
  label.setAttribute('x', String(mid.x))
  label.setAttribute('y', String(mid.y))
  label.textContent = clicks === 1 ? '1' : String(clicks)
  group.append(bg, label)
  svg.appendChild(group)
  return group
}

function cardBodyHeight(step) {
  if (step.shotW && step.shotH) return Math.round((CARD_W * step.shotH) / step.shotW)
  return 160
}

function flowStats(flow) {
  return metricsBoard?.flows?.find((item) => item.id === flow?.id) || null
}

function stepStat(step, flow) {
  return flowStats(flow)?.steps?.[step.id] || null
}

function statTexts(step, flow) {
  const stat = stepStat(step, flow)
  if (!stat) return []
  return [stat.reach, stat.time, stat.leave, stat.unhappy].filter(Boolean)
}

function cardHeight(step, flow) {
  const stat = stepStat(step, flow)
  const lines = [stat?.leave, stat?.unhappy].filter(Boolean).length
  const meter = stat?.reachCount ? 34 : 0
  const chips = step.gestures?.length ? 28 : 0
  return cardBodyHeight(step) + 58 + meter + chips + lines * 18 + badgeHeight(step)
}

function laneMetrics(flow, captions, bodies) {
  let y = 12
  return flow.lanes.map((lane) => {
    const steps = flow.steps.filter((s) => s.laneId === lane.id)
    const height = Math.max(200, ...steps.map((step) => (bodies?.get(step.id) || cardBodyHeight(step)) + (captions?.get(step.id) || 72))) + 28
    const metric = { y, height }
    y += height
    return metric
  })
}

function stepPos(flow, step, metrics) {
  const lane = Math.max(0, flow.lanes.findIndex((l) => l.id === step.laneId))
  return { x: LABEL_W / zoom + step.col * (CARD_W + COL_GAP), y: metrics[lane].y + 16 }
}

function stepBody(step, bodies) {
  return bodies?.get(step.id) || cardBodyHeight(step)
}

function edgePath(flow, from, to, metrics, bodies) {
  const a = stepPos(flow, from, metrics)
  const b = stepPos(flow, to, metrics)
  const fromBody = stepBody(from, bodies)
  const toBody = stepBody(to, bodies)
  if (Math.abs(a.x - b.x) < 8 && b.y > a.y) {
    const x = a.x + CARD_W / 2
    const y1 = a.y + fromBody
    return `M${x},${y1} C${x},${y1 + 28} ${x},${b.y - 28} ${x},${b.y}`
  }
  const x1 = a.x + CARD_W
  const y1 = a.y + Math.min(120, fromBody / 2)
  const x2 = b.x
  const y2 = b.y + Math.min(120, toBody / 2)
  const mx = (x1 + x2) / 2
  return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`
}

/** Unit normal that points down the page, so underlays stay inside the stage. */
function linkNormal(dx, dy) {
  const len = Math.hypot(dx, dy) || 1
  let ox = -dy / len
  let oy = dx / len
  if (oy < 0 || (Math.abs(oy) < 0.001 && ox > 0)) {
    ox = -ox
    oy = -oy
  }
  return { ox, oy, len }
}

function normalizeHrefPath(href) {
  try {
    let path = /^https?:/i.test(href) ? new URL(href).pathname : String(href || '').split(/[?#]/)[0]
    if (!path) return ''
    if (!path.startsWith('/')) path = `/${path}`
    return path.length > 1 ? path.replace(/\/+$/, '') : '/'
  } catch {
    return ''
  }
}

function pathMatchesStep(path, step) {
  const route = normalizeHrefPath(step.route || '/')
  const pattern = normalizeHrefPath(step.pattern || step.route || '/')
  const value = normalizeHrefPath(path)
  if (!value) return false
  if (value === route || value === pattern) return true
  if (!pattern.includes('*')) return false
  const body = pattern
    .split('/')
    .map((seg, index) => {
      if (index === 0) return ''
      if (seg === '*') return '[^/]+'
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('/')
  return new RegExp(`^${body}/?$`, 'i').test(value)
}

function findShotAnchor(step, toward) {
  for (const anchor of step.linkAnchors || []) {
    if (pathMatchesStep(anchor.path || anchor.href || '', toward)) return anchor
  }
  return null
}

function linkAttachY(step, toward, body) {
  const anchor = findShotAnchor(step, toward)
  if (anchor?.yRatio != null) return Math.min(body - 6, Math.max(10, anchor.yRatio * body))
  return null
}

function linkEnds(from, to, bodies) {
  const fromBody = stepBody(from, bodies)
  const toBody = stepBody(to, bodies)
  const fromY = linkAttachY(from, to, fromBody)
  const toY = linkAttachY(to, from, toBody)
  const y1 = fromY ?? fromBody * 0.62
  const y2 = toY ?? (fromY != null ? Math.min(toBody - 6, Math.max(10, (fromY / fromBody) * toBody)) : toBody * 0.62)
  return { fromBody, toBody, y1, y2, anchored: fromY != null || toY != null }
}

/** Thin page-link underlays: side-to-side, height matched to the control on the screenshot when known. */
function linkPath(flow, from, to, metrics, bodies, bow = 1) {
  const a = stepPos(flow, from, metrics)
  const b = stepPos(flow, to, metrics)
  const { y1: ay, y2: by, anchored } = linkEnds(from, to, bodies)
  const forward = b.x >= a.x
  const x1 = forward ? a.x + CARD_W : a.x
  const x2 = forward ? b.x : b.x + CARD_W
  const y1 = a.y + ay
  const y2 = b.y + by
  const mx = (x1 + x2) / 2
  const my = (y1 + y2) / 2
  const { ox, oy, len } = linkNormal(x2 - x1, y2 - y1)
  const rise = (anchored ? Math.min(48, Math.max(18, len * 0.12)) : Math.min(100, Math.max(42, len * 0.28))) * Math.abs(bow)
  return `M${x1},${y1} Q${mx + ox * rise},${my + oy * rise} ${x2},${y2}`
}

function linkMid(flow, from, to, metrics, bodies, bow = 1) {
  const a = stepPos(flow, from, metrics)
  const b = stepPos(flow, to, metrics)
  const { y1: ay, y2: by, anchored } = linkEnds(from, to, bodies)
  const forward = b.x >= a.x
  const x1 = forward ? a.x + CARD_W : a.x
  const x2 = forward ? b.x : b.x + CARD_W
  const y1 = a.y + ay
  const y2 = b.y + by
  const mx = (x1 + x2) / 2
  const my = (y1 + y2) / 2
  const { ox, oy, len } = linkNormal(x2 - x1, y2 - y1)
  const rise = (anchored ? Math.min(48, Math.max(18, len * 0.12)) : Math.min(100, Math.max(42, len * 0.28))) * Math.abs(bow)
  return { x: mx + ox * rise * 0.5, y: my + oy * rise * 0.5 }
}

function edgeMid(flow, from, to, metrics, bodies) {
  const a = stepPos(flow, from, metrics)
  const b = stepPos(flow, to, metrics)
  const fromBody = stepBody(from, bodies)
  const toBody = stepBody(to, bodies)
  if (Math.abs(a.x - b.x) < 8 && b.y > a.y) {
    return { x: a.x + CARD_W / 2, y: (a.y + fromBody + b.y) / 2 }
  }
  return {
    x: (a.x + CARD_W + b.x) / 2,
    y: (a.y + Math.min(120, fromBody / 2) + b.y + Math.min(120, toBody / 2)) / 2,
  }
}

function orderedSteps(flow) {
  const items = []
  for (const lane of flow.lanes) {
    const steps = flow.steps.filter((s) => s.laneId === lane.id).sort((a, b) => a.col - b.col)
    for (const step of steps) items.push({ step, lane })
  }
  return items
}

function sourceStep(flow, step) {
  const edge = flow.edges.find((e) => e.to === step.id)
  return edge ? flow.steps.find((s) => s.id === edge.from) : null
}

let viewerItems = []
let viewerIndex = 0
let viewerFlow = null

function showViewer() {
  const item = viewerItems[viewerIndex]
  if (!item) return
  const { step, lane } = item
  const title = step.kind === 'happy' ? step.name : sourceStep(viewerFlow, step)?.name || step.route || step.name
  document.querySelector('#viewer-kicker').textContent = lane.name
  document.querySelector('#viewer-name').textContent = title
  const detail = [step.route, step.kind !== 'happy' && step.name !== title ? step.name : step.evidence, ...statTexts(step, viewerFlow)].filter(Boolean).join(' · ')
  document.querySelector('#viewer-route').textContent = detail
  const img = document.querySelector('#viewer-img')
  const empty = document.querySelector('#viewer-empty')
  if (step.shotId) {
    img.hidden = false
    img.src = `/shots/${step.shotId}`
    img.alt = step.name
    empty.hidden = true
  } else {
    img.hidden = true
    img.removeAttribute('src')
    empty.hidden = false
    empty.textContent = step.shotError || 'No capture yet. Capture visuals to see this screen.'
  }
  document.querySelector('#viewer-prev').disabled = viewerIndex === 0
  document.querySelector('#viewer-next').disabled = viewerIndex >= viewerItems.length - 1
}

function openViewer(flow, step) {
  viewerFlow = flow
  viewerItems = orderedSteps(flow)
  viewerIndex = Math.max(0, viewerItems.findIndex((item) => item.step.id === step.id))
  showViewer()
  if (!viewer.open) viewer.showModal()
}

document.querySelector('#viewer-prev').onclick = () => {
  if (viewerIndex === 0) return
  viewerIndex -= 1
  showViewer()
}

document.querySelector('#viewer-next').onclick = () => {
  if (viewerIndex >= viewerItems.length - 1) return
  viewerIndex += 1
  showViewer()
}

viewer.addEventListener('click', (event) => {
  if (event.target === viewer) viewer.close()
})

document.addEventListener('keydown', (event) => {
  if (!viewer.open) return
  if (event.key === 'ArrowRight') document.querySelector('#viewer-next').click()
  if (event.key === 'ArrowLeft') document.querySelector('#viewer-prev').click()
})

function selectFlow(id) {
  activeId = id
  fetch('/api/active', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
  render(session.flows)
}

function formatDay(iso) {
  const [year, month, day] = String(iso || '').split('-').map(Number)
  if (!year || !month || !day) return ''
  const date = new Date(year, month - 1, day)
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return date.toLocaleDateString('en-GB', sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })
}

function figure(value, label) {
  const item = el('div', 'figure')
  item.append(el('strong', null, value))
  item.append(el('span', null, label))
  return item
}

function summaryLine(summary) {
  if (!summary?.sessions) return null
  const visits = summary.sessions === 1 ? '1 visit' : `${summary.sessions.toLocaleString('en-GB')} visits`
  const parts = [visits]
  if (summary.left != null) parts.push(`${summary.left}% left straight away`)
  if (summary.span) parts.push(`A visit lasts ${summary.span.charAt(0).toLowerCase()}${summary.span.slice(1)}`)
  return parts.length === 1 ? parts[0] : `${parts.join('. ')}.`
}

function flowScore(flow) {
  return session?.scores?.flows?.find((item) => item.flowId === flow?.id) || null
}

function easeWord(score) {
  if (score >= 5) return 'Very easy'
  if (score === 4) return 'Easy'
  if (score === 3) return 'Workable'
  if (score === 2) return 'Awkward'
  return 'Hard'
}

const easeSheet = document.querySelector('#ease-sheet')
const easeSheetTitle = document.querySelector('#ease-sheet-title')
const easeSheetBody = document.querySelector('#ease-sheet-body')

function fillEaseStory(target, story) {
  target.replaceChildren()
  target.append(el('p', 'ease-blurb', story.blurb || 'Structural ease for this journey.'))
  const appendGroup = (label, items, held) => {
    if (!items?.length) return
    target.append(el('p', 'ease-label', label))
    const list = el('ul', held ? 'ease-list ease-list-held' : 'ease-list')
    const byTitle = new Map()
    for (const item of items) {
      if (!byTitle.has(item.title)) byTitle.set(item.title, [])
      byTitle.get(item.title).push(item.reading)
    }
    for (const [title, readings] of byTitle) {
      const row = el('li')
      row.append(el('span', 'ease-dim', title))
      row.append(document.createTextNode(` — ${readings.join(' ')}`))
      list.append(row)
    }
    target.append(list)
  }
  appendGroup('What helps', story.helped, false)
  appendGroup('What holds it back', story.held, true)
  if (!story.helped?.length && !story.held?.length) {
    target.append(el('p', 'journey-note', 'Remap the project to refresh the plain-language reasons.'))
  }
  target.append(el('p', 'ease-footnote', 'Based on the mapped path structure — not a claim about how the product feels to use.'))
}

function openEaseSheet(flow) {
  const scored = flowScore(flow)
  if (!scored?.overall || !easeSheet) return
  easeSheetTitle.textContent = `${easeWord(scored.overall)} to use`
  fillEaseStory(easeSheetBody, scored.story || { blurb: '', helped: [], held: [] })
  if (!easeSheet.open) easeSheet.showModal()
}

function easeChip(flow) {
  const scored = flowScore(flow)
  if (!scored?.overall) return null
  const chip = el('button', 'ease-chip')
  chip.type = 'button'
  chip.append(el('strong', null, `${easeWord(scored.overall)} to use`))
  chip.append(el('span', null, 'Why'))
  chip.onclick = () => openEaseSheet(flow)
  return chip
}

function journeyBar(flow) {
  const bar = el('div', 'journey-bar')
  const stats = flowStats(flow)
  if (stats?.headline || stats?.finish) bar.append(el('p', 'journey-headline', [stats.headline, stats.finish].filter(Boolean).join(' · ')))
  if (stats?.summary?.sessions) {
    const row = el('div', 'figures')
    const summary = stats.summary
    row.append(figure(summary.sessions.toLocaleString('en-GB'), summary.sessions === 1 ? 'visit' : 'visits'))
    if (summary.left != null) row.append(figure(`${summary.left}%`, 'left straight away'))
    if (summary.span) row.append(figure(summary.span.replace(/^About /, ''), 'a typical visit'))
    bar.append(row)
  }
  const ease = easeChip(flow)
  if (ease) bar.append(ease)
  const selected = choices.changes[flow.id] || stats?.changeId || null
  if (flow.changes?.length) {
    const strip = el('div', 'changes')
    const last = el('button', null, 'Last 28 days')
    last.type = 'button'
    last.setAttribute('aria-pressed', String(selected === 'none'))
    last.onclick = () => selectChange(flow, 'none')
    strip.append(last)
    for (const change of flow.changes) {
      const button = el('button', null, `${change.name} · ${formatDay(change.day)}`)
      button.type = 'button'
      button.setAttribute('aria-pressed', String(selected === change.id))
      button.onclick = () => selectChange(flow, change.id)
      strip.append(button)
    }
    bar.append(strip)
  }
  const notes = stats?.notes?.length
    ? stats.notes
    : selected && selected !== 'none' && flow.changes?.length && !flow.changes.some((change) => change.source === 'deploy')
      ? ['Dates are when the project changed. The site may have gone live later.']
      : []
  for (const note of notes) bar.append(el('p', 'journey-note', note))
  return bar.childNodes.length ? bar : null
}

function selectChange(flow, id) {
  choices.changes[flow.id] = id
  if (googleStatus.connected && googleStatus.property) loadMetrics()
  else render(session.flows)
}

function needsGoogleSite() {
  return Boolean(googleStatus.connected && !googleStatus.property)
}

function paintAnalytics() {
  const connected = Boolean(googleStatus.property)
  // Always offer Connect / Choose site until a property is bound to this project.
  connectBtn.hidden = connected
  connectBtn.textContent = needsGoogleSite() ? 'Choose site' : 'Connect Google'
  visits.hidden = !connected
  const deviceLabel = deviceSelect.selectedOptions[0]?.textContent || 'Everyone'
  const sourceLabel = sourceSelect.selectedOptions[0]?.textContent || 'Everyone'
  const siteLabel = googleStatus.property?.label || googleStatus.property?.url || ''
  visitsToggle.textContent =
    deviceLabel === 'Everyone' && sourceLabel === 'Everyone'
      ? siteLabel || 'Everyone'
      : `${deviceLabel} · ${sourceLabel}`
}

function setAnalyticsNote(text, error = false) {
  if (capturing && !error) return
  const connectPrompt = /connect google|choose (a )?site|choose which site/i.test(text || '')
  if (connectPrompt) {
    paintAnalytics()
    setStatus(text, error, {
      label: needsGoogleSite() ? 'Choose site' : 'Connect Google',
      onClick: () => connectBtn.click(),
    })
    return
  }
  setStatus(text, error)
}

async function refreshGoogle() {
  googleStatus = await (await fetch('/api/google/status')).json()
  return googleStatus
}

async function presentAnalytics() {
  paintAnalytics()
  try {
    await refreshGoogle()
    paintAnalytics()
    if (googleStatus.connected) await afterConnect()
  } catch (err) {
    setAnalyticsNote(err.message, true)
  }
}

function pollConnect() {
  clearInterval(connectPoll)
  const started = Date.now()
  connectPoll = setInterval(async () => {
    try {
      await refreshGoogle()
      if (!googleStatus.connected) {
        if (Date.now() - started > 180000) {
          clearInterval(connectPoll)
          setAnalyticsNote('Still waiting for Google. Connect again if that window was closed.', true)
        }
        return
      }
      clearInterval(connectPoll)
      await afterConnect()
    } catch (err) {
      clearInterval(connectPoll)
      setAnalyticsNote(err.message, true)
    }
  }, 1000)
}

async function afterConnect() {
  const resolved = await post('/api/google/resolve')
  if (resolved.needsChoice) {
    // Drop a sticky property from a previous project so visits aren't from the wrong site.
    googleStatus = { ...googleStatus, connected: true, property: null }
    paintAnalytics()
    setAnalyticsNote('Choose which site’s visits to show.')
    openSites(resolved.sites || [])
    return
  }
  googleStatus = { ...googleStatus, connected: true, property: resolved.property || null }
  paintAnalytics()
  await loadMetrics()
}

async function loadMetrics() {
  if (!session?.flows?.length) return
  setAnalyticsNote('Reading visits…')
  try {
    const res = await post('/api/metrics', { device: choices.device, source: choices.source, changes: choices.changes })
    if (res.needsChoice) {
      setAnalyticsNote('')
      openSites(res.sites || [])
      return
    }
    metricsBoard = res
    googleStatus = { ...googleStatus, connected: true, property: res.property || googleStatus.property }
    for (const flow of res.flows || []) {
      choices.changes[flow.id] = flow.changeId
      const live = session.flows.find((item) => item.id === flow.id)
      if (!live) continue
      if (flow.links) live.links = flow.links
      if (flow.edgeClicks?.length) {
        const byKey = new Map(flow.edgeClicks.map((edge) => [`${edge.from}->${edge.to}`, edge.clicks]))
        for (const edge of live.edges || []) {
          const clicks = byKey.get(`${edge.from}->${edge.to}`)
          if (clicks) edge.clicks = clicks
          else delete edge.clicks
        }
      }
    }
    paintAnalytics()
    render(session.flows)
    setAnalyticsNote('')
  } catch (err) {
    setAnalyticsNote(err.message, true)
  }
}

function openSites(sites) {
  const list = document.querySelector('#site-list')
  list.replaceChildren()
  if (!sites.length) {
    setAnalyticsNote("This account can't see that site. Switch to the Google account your company uses for the website.", true)
    return
  }
  const hint = `${session?.project?.name || ''} ${session?.project?.path || ''}`.toLowerCase()
  const preferred = sites.findIndex((site) => {
    const hay = `${site.label || ''} ${site.url || ''}`.toLowerCase()
    if (/archivist|familytree/.test(hint) && /archivist|familytree/.test(hay)) return true
    return hint.split(/[\s/_-]+/).filter((part) => part.length > 3).some((part) => hay.includes(part))
  })
  sites.forEach((site, index) => {
    const label = document.createElement('label')
    label.className = 'site-choice'
    const input = document.createElement('input')
    input.type = 'radio'
    input.name = 'site'
    input.value = site.id
    input.checked = index === (preferred >= 0 ? preferred : 0)
    label.append(input, document.createTextNode(site.url ? `${site.label} — ${site.url}` : site.label))
    list.append(label)
  })
  document.querySelector('#site-pick').showModal()
}

function render(flows) {
  hideLinkTip()
  board.innerHTML = ''
  const flow = flows.find((f) => f.id === activeId) ?? flows[0]
  if (!flow) {
    mapFlow = null
    zoomBar.hidden = true
    return
  }
  activeId = flow.id
  mapFlow = flow

  const tabs = document.createElement('div')
  tabs.className = 'journeys'
  const label = document.createElement('span')
  label.className = 'journeys-label'
  label.textContent = 'Paths'
  const group = document.createElement('div')
  group.className = 'journey-group'
  group.setAttribute('role', 'group')
  group.setAttribute('aria-label', 'Paths')
  for (const item of flows) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = item.name
    button.setAttribute('aria-pressed', String(item.id === flow.id))
    button.onclick = () => selectFlow(item.id)
    group.appendChild(button)
  }
  tabs.append(label, group)
  board.appendChild(tabs)
  const bar = journeyBar(flow)
  if (bar) board.appendChild(bar)

  const byId = new Map(flow.steps.map((s) => [s.id, s]))
  const metrics = laneMetrics(flow)
  let width = LABEL_W + CARD_W + 40
  let height = metrics.reduce((sum, lane) => sum + lane.height, 24)
  for (const step of flow.steps) {
    const p = stepPos(flow, step, metrics)
    width = Math.max(width, p.x + CARD_W + 48)
    height = Math.max(height, p.y + cardHeight(step, flow) + 24)
  }

  const stage = document.createElement('div')
  stage.className = 'stage'
  const canvas = document.createElement('div')
  canvas.className = 'canvas'
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  const captionsLayer = document.createElement('div')
  captionsLayer.className = 'captions'

  flow.lanes.forEach((lane, index) => {
    const wash = document.createElement('div')
    wash.className = `lane-wash ${lane.kind}`
    wash.dataset.lane = lane.id
    wash.style.top = `${metrics[index].y}px`
    wash.style.height = `${metrics[index].height - 12}px`
    const laneSteps = flow.steps.filter((step) => step.laneId === lane.id)
    if (lane.kind === 'happy' || !laneSteps.length) {
      wash.style.left = '150px'
      wash.style.right = '0'
    } else {
      const xs = laneSteps.map((step) => stepPos(flow, step, metrics).x)
      const left = Math.min(...xs) - 12
      const right = Math.max(...xs) + CARD_W + 12
      wash.style.left = `${left}px`
      wash.style.width = `${right - left}px`
    }
    canvas.appendChild(wash)
    const label = document.createElement('div')
    label.className = 'lane-label'
    label.dataset.lane = lane.id
    label.style.top = `${metrics[index].y + 10}px`
    label.textContent = lane.name
    captionsLayer.appendChild(label)
  })

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  ;(flow.links || []).forEach((link, index) => {
    const from = byId.get(link.from)
    const to = byId.get(link.to)
    if (!from || !to) return
    // Arc under the happy path so the curve stays inside the stage (upward bows clip).
    const bow = from.kind === 'happy' && to.kind === 'happy' ? 1 + (index % 3) * 0.35 : index % 2 === 0 ? 1 : -1
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.dataset.from = link.from
    path.dataset.to = link.to
    path.dataset.link = '1'
    path.dataset.bow = String(bow)
    path.setAttribute('d', linkPath(flow, from, to, metrics, null, bow))
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', '#44403c')
    path.setAttribute('stroke-width', '1.5')
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-dasharray', link.conditional ? '3 4' : '0')
    path.setAttribute('opacity', '0.55')
    svg.appendChild(path)
    if (link.clicks > 0) {
      const mid = linkMid(flow, from, to, metrics, null, bow)
      const group = countBadge(svg, mid, link.clicks, { from: link.from, to: link.to, bow, link: true })
      attachCountTip(group, flow, from, to, link.clicks, 'link')
    }
  })
  for (const edge of flow.edges) {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (!from || !to) continue
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.dataset.from = edge.from
    path.dataset.to = edge.to
    path.setAttribute('d', edgePath(flow, from, to, metrics, null))
    path.setAttribute('fill', 'none')
    const fromCount = stepStat(from, flow)?.reachCount || 0
    const toCount = stepStat(to, flow)?.reachCount || 0
    const share = fromCount > 0 ? Math.max(0.08, Math.min(1, toCount / fromCount)) : 0.35
    path.setAttribute('stroke', EDGE_COLOR[to.kind] || EDGE_COLOR.happy)
    path.setAttribute('stroke-width', String(to.kind === 'happy' ? 1.25 + share * 4 : 1.5))
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('marker-end', 'url(#arrow)')
    svg.appendChild(path)
    if (edge.clicks > 0 && to.kind !== 'unhappy') {
      const mid = edgeMid(flow, from, to, metrics, null)
      const group = countBadge(svg, mid, edge.clicks, { from: edge.from, to: edge.to })
      attachCountTip(group, flow, from, to, edge.clicks, 'edge')
    }
  }
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs')
  defs.innerHTML = '<marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill="#57534e"/></marker>'
  svg.prepend(defs)
  canvas.appendChild(svg)

  for (const step of flow.steps) {
    const p = stepPos(flow, step, metrics)
    const card = document.createElement('article')
    card.className = 'card'
    card.dataset.step = step.id
    card.tabIndex = 0
    card.setAttribute('role', 'button')
    card.setAttribute('aria-label', `View ${step.name}`)
    card.style.left = `${p.x}px`
    card.style.top = `${p.y}px`
    const open = () => openViewer(flow, step)
    card.onclick = open
    card.onkeydown = (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      open()
    }
    const shot = document.createElement('div')
    shot.className = 'shot'
    if (step.shotId) {
      const img = document.createElement('img')
      img.src = `/shots/${step.shotId}`
      img.alt = step.name
      img.addEventListener('load', () => {
        if (userZoom) place()
        else fitZoom(false)
      })
      shot.appendChild(img)
    } else shot.textContent = step.shotError ? 'Could not capture this route' : step.state || 'No capture yet'
    const meta = document.createElement('div')
    meta.className = 'caption'
    meta.dataset.step = step.id
    meta.onclick = open
    const name = document.createElement('strong')
    name.textContent = step.name
    const route = document.createElement('p')
    route.className = 'route'
    route.textContent = step.evidence || step.route || ''
    meta.append(name, route)
    if (step.gestures?.length) {
      const chips = el('div', 'chips')
      for (const gesture of step.gestures) chips.append(el('span', 'chip', gesture))
      meta.append(chips)
    }
    const stat = stepStat(step, flow)
    if (stat?.reachCount) {
      const happyCounts = flow.steps.filter((item) => item.kind === 'happy').map((item) => stepStat(item, flow)?.reachCount || 0)
      const scale = Math.max(stat.reachCount, ...happyCounts, 1)
      const meter = el('div', 'meter')
      const labels = el('div', 'meter-labels')
      const countLabel = stat.reachCount === 1 ? '1 visit' : `${stat.reachCount.toLocaleString('en-GB')} visits`
      labels.append(el('span', null, countLabel))
      if (stat.time) labels.append(el('span', 'meter-time', stat.time.replace(/\s+here$/, '').replace(/^About /, '')))
      const track = el('div', 'meter-track')
      const fill = el('div', 'meter-fill')
      fill.style.width = `${Math.max(6, Math.round((stat.reachCount / scale) * 100))}%`
      track.append(fill)
      meter.append(labels, track)
      meta.append(meter)
    }
    for (const line of [stat?.leave, stat?.unhappy].filter(Boolean)) meta.append(el('p', 'stat', line))
    const badges = badgeRow(step)
    if (badges) meta.append(badges)
    card.append(shot)
    canvas.appendChild(card)
    captionsLayer.appendChild(meta)
  }

  stage.append(canvas, captionsLayer)
  board.appendChild(stage)
  const ready = flows.some((f) => f.steps.length)
  empty.hidden = ready
  board.hidden = !ready
  zoomBar.hidden = !ready
  if (ready) {
    if (userZoom) applyZoom()
    else fitZoom(false)
  }
  projectBtn.hidden = !session?.project
  projectBtn.textContent = session?.project?.name || 'Project'
  pdfBtn.disabled = !ready
  figmaBtn.disabled = !ready
  syncOpenSiteButton()
}

function syncOpenSiteButton() {
  const live = session?.project?.liveUrl
  if (!openSiteBtn) return
  openSiteBtn.hidden = !live
  openSiteBtn.title = live ? `Open ${live} in a new tab` : 'Open the running local app in a new tab'
}

function clampZoom(value) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value))
}

/** Captions stay a bit more readable than raw zoom, but shrink when Fit would make them collide. */
function labelScale() {
  const screenCard = CARD_W * zoom
  return Math.min(1, Math.max(zoom, screenCard / 168))
}

function place(anchor) {
  const canvas = board.querySelector('.canvas')
  const stage = board.querySelector('.stage')
  const flow = mapFlow
  if (!canvas || !stage || !flow) return
  canvas.style.setProperty('--z', String(zoom))
  const scale = labelScale()
  stage.classList.toggle('zoomed-out', zoom < 0.4)
  const captions = new Map()
  const bodies = new Map()
  for (const card of canvas.querySelectorAll('.card')) bodies.set(card.dataset.step, card.offsetHeight)
  for (const caption of stage.querySelectorAll('.caption')) {
    const screenW = CARD_W * zoom
    caption.style.width = `${screenW / scale}px`
    caption.style.transform = `scale(${scale})`
    caption.style.transformOrigin = 'top left'
    caption.classList.toggle('compact', scale < 0.55)
    captions.set(caption.dataset.step, (caption.offsetHeight * scale) / zoom)
  }
  const metrics = laneMetrics(flow, captions, bodies)
  const byId = new Map(flow.steps.map((step) => [step.id, step]))
  let width = LABEL_W / zoom + CARD_W + 40
  let height = metrics.reduce((sum, lane) => sum + lane.height, 24)
  for (const step of flow.steps) {
    const p = stepPos(flow, step, metrics)
    width = Math.max(width, p.x + CARD_W + 48)
    height = Math.max(height, p.y + (bodies.get(step.id) || cardBodyHeight(step)) + (captions.get(step.id) || 0) + 24)
  }
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  for (const wash of canvas.querySelectorAll('.lane-wash')) {
    const index = flow.lanes.findIndex((lane) => lane.id === wash.dataset.lane)
    if (index < 0) continue
    const lane = flow.lanes[index]
    wash.style.top = `${metrics[index].y}px`
    wash.style.height = `${metrics[index].height - 12}px`
    const laneSteps = flow.steps.filter((step) => step.laneId === lane.id)
    if (lane.kind === 'happy' || !laneSteps.length) {
      wash.style.left = `${LABEL_W / zoom - 18}px`
      wash.style.right = '0'
      wash.style.width = ''
    } else {
      const xs = laneSteps.map((step) => stepPos(flow, step, metrics).x)
      const left = Math.min(...xs) - 12
      const right = Math.max(...xs) + CARD_W + 12
      wash.style.left = `${left}px`
      wash.style.width = `${right - left}px`
      wash.style.right = ''
    }
  }
  for (const label of stage.querySelectorAll('.lane-label')) {
    const index = flow.lanes.findIndex((lane) => lane.id === label.dataset.lane)
    if (index < 0) continue
    label.style.top = `${metrics[index].y * zoom + 10}px`
    label.style.transform = `scale(${scale})`
    label.style.transformOrigin = 'top left'
  }
  for (const card of canvas.querySelectorAll('.card')) {
    const step = byId.get(card.dataset.step)
    if (!step) continue
    const p = stepPos(flow, step, metrics)
    card.style.left = `${p.x}px`
    card.style.top = `${p.y}px`
  }
  for (const caption of stage.querySelectorAll('.caption')) {
    const step = byId.get(caption.dataset.step)
    if (!step) continue
    const p = stepPos(flow, step, metrics)
    const body = bodies.get(step.id) || cardBodyHeight(step)
    caption.style.left = `${p.x * zoom}px`
    caption.style.top = `${(p.y + body) * zoom - 1}px`
  }
  const svg = canvas.querySelector('svg')
  if (svg) {
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
    for (const path of svg.querySelectorAll('path[data-from]')) {
      const from = byId.get(path.dataset.from)
      const to = byId.get(path.dataset.to)
      if (!from || !to) continue
      if (path.dataset.link) {
        const bow = Number(path.dataset.bow) || 1
        path.setAttribute('d', linkPath(flow, from, to, metrics, bodies, bow))
        continue
      }
      const a = stepPos(flow, from, metrics)
      const b = stepPos(flow, to, metrics)
      if (Math.abs(a.x - b.x) < 8 && b.y > a.y) {
        const x = a.x + CARD_W / 2
        const y1 = a.y + (bodies.get(from.id) || cardBodyHeight(from)) + (captions.get(from.id) || 0)
        path.setAttribute('d', `M${x},${y1} C${x},${y1 + 28} ${x},${b.y - 28} ${x},${b.y}`)
      } else {
        path.setAttribute('d', edgePath(flow, from, to, metrics, bodies))
      }
    }
    for (const group of svg.querySelectorAll('g[data-link-label]')) {
      const from = byId.get(group.dataset.from)
      const to = byId.get(group.dataset.to)
      if (!from || !to) continue
      const bow = Number(group.dataset.bow) || 1
      const mid = group.dataset.bow ? linkMid(flow, from, to, metrics, bodies, bow) : edgeMid(flow, from, to, metrics, bodies)
      const bg = group.querySelector('.link-count-bg')
      const label = group.querySelector('.link-count')
      if (bg) {
        bg.setAttribute('cx', String(mid.x))
        bg.setAttribute('cy', String(mid.y))
      }
      if (label) {
        label.setAttribute('x', String(mid.x))
        label.setAttribute('y', String(mid.y))
      }
    }
  }
  canvas.style.transform = `scale(${zoom})`
  stage.style.width = `${Math.ceil(width * zoom)}px`
  stage.style.height = `${Math.ceil(height * zoom)}px`
  zoomLevel.textContent = `${Math.round(zoom * 100)}%`
  zoomOutBtn.disabled = zoom <= ZOOM_MIN + 0.001
  zoomInBtn.disabled = zoom >= ZOOM_MAX - 0.001
  if (anchor) {
    const rect = canvas.getBoundingClientRect()
    const scale = anchor.zoom ? zoom / anchor.zoom : 1
    const nextX = anchor.sx < LABEL_W ? anchor.sx : LABEL_W + (anchor.sx - LABEL_W) * scale
    const nextY = anchor.sy * scale
    window.scrollBy(rect.left + nextX - anchor.clientX, rect.top + nextY - anchor.clientY)
  }
}

function pointerAnchor(clientX, clientY) {
  const canvas = board.querySelector('.canvas')
  const rect = canvas?.getBoundingClientRect()
  if (!rect || !rect.width) return null
  return {
    sx: clientX - rect.left,
    sy: clientY - rect.top,
    clientX,
    clientY,
    zoom,
  }
}

function applyZoom() {
  place()
}

function fitZoom(scroll) {
  const topChrome = (document.querySelector('.top')?.offsetHeight || 0)
    + (board.querySelector('.journeys')?.offsetHeight || 0)
    + (board.querySelector('.journey-bar')?.offsetHeight || 0)
  const availW = Math.max(320, window.innerWidth - 56)
  const availH = Math.max(220, window.innerHeight - topChrome - 72)
  const cols = mapFlow ? Math.max(0, ...mapFlow.steps.map((step) => step.col)) : 0
  let next = clampZoom(Math.min(1, (availW - 40) / (LABEL_W + (cols + 1) * (CARD_W + COL_GAP))))
  for (let i = 0; i < 5; i++) {
    zoom = next
    place()
    const stage = board.querySelector('.stage')
    if (!stage?.offsetWidth || !stage?.offsetHeight) break
    // Fit across the width; allow vertical scroll instead of crushing to tiny zoom.
    const byWidth = zoom * availW / stage.offsetWidth
    let fitted = Math.min(1, byWidth)
    const heightAtFit = stage.offsetHeight * (fitted / zoom)
    if (heightAtFit > availH * 2.4) {
      fitted = Math.min(fitted, zoom * (availH * 2.4) / stage.offsetHeight)
    }
    fitted = clampZoom(Math.max(Math.min(byWidth, 0.42), Math.min(1, fitted)))
    if (Math.abs(fitted - zoom) < 0.02) {
      next = fitted
      break
    }
    next = fitted
  }
  zoom = next
  place()
  if (scroll) window.scrollTo(0, 0)
}

function nudgeZoom(direction, clientX, clientY) {
  const anchor = clientX != null && clientY != null ? pointerAnchor(clientX, clientY) : null
  userZoom = true
  zoom = clampZoom(zoom * (direction > 0 ? 1.2 : 1 / 1.2))
  place(anchor)
}

zoomOutBtn.onclick = () => nudgeZoom(-1)
zoomInBtn.onclick = () => nudgeZoom(1)
zoomFitBtn.onclick = () => {
  userZoom = false
  fitZoom(true)
}

function overMap(event) {
  const stage = board.querySelector('.stage')
  if (!stage || board.hidden) return false
  if (stage.contains(event.target)) return true
  const rect = stage.getBoundingClientRect()
  return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom
}

window.addEventListener('wheel', (event) => {
  if (!event.ctrlKey || !overMap(event)) return
  event.preventDefault()
  const anchor = pointerAnchor(event.clientX, event.clientY)
  userZoom = true
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1
  zoom = clampZoom(zoom * Math.exp(-event.deltaY * unit * 0.008))
  place(anchor)
}, { capture: true, passive: false })

let pinchStart = 1
window.addEventListener('gesturestart', (event) => {
  if (!overMap(event)) return
  event.preventDefault()
  pinchStart = zoom
}, { passive: false })
window.addEventListener('gesturechange', (event) => {
  if (!overMap(event)) return
  event.preventDefault()
  const anchor = pointerAnchor(event.clientX, event.clientY)
  userZoom = true
  zoom = clampZoom(pinchStart * event.scale)
  place(anchor)
}, { passive: false })

window.addEventListener('resize', () => {
  if (board.hidden || userZoom) return
  fitZoom(false)
})

document.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return
  const tag = document.activeElement?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
  if (board.hidden) return
  if (event.key === '+' || event.key === '=') {
    event.preventDefault()
    nudgeZoom(1)
  } else if (event.key === '-' || event.key === '_') {
    event.preventDefault()
    nudgeZoom(-1)
  } else if (event.key === '0') {
    event.preventDefault()
    userZoom = false
    fitZoom(true)
  }
})

function showProjectDialog() {
  setDialogStatus('')
  if (!openDialog.open) openDialog.showModal()
}

document.querySelector('#open').onclick = showProjectDialog
projectBtn.onclick = showProjectDialog
initPreflight({ getSession: () => session, rerender: () => session && render(session.flows) })

document.querySelector('#pick').onclick = async () => {
  setDialogStatus('Opening folder picker…')
  try {
    const res = await post('/api/pick')
    if (res.cancelled) return setDialogStatus('')
    pathInput.value = res.path
    setDialogStatus('')
  } catch (err) {
    setDialogStatus(err.message, true)
  }
}

async function captureVisuals() {
  capturing = true
  setStatus('Photographing each screen…')
  try {
    const email = loginEmailInput?.value.trim() || ''
    const password = loginPasswordInput?.value || ''
    const appUrl = appUrlInput?.value.trim() || session.project?.liveUrl || ''
    if (email) sessionStorage.setItem('flowmap-login', JSON.stringify({ email }))
    if (appUrl) sessionStorage.setItem('flowmap-app-url', appUrl)
    const res = await post('/api/capture', {
      path: pathInput.value.trim(),
      // Prefer the URL you typed (e.g. :4000), then a prior capture of this project.
      url: appUrl || undefined,
      email: email || undefined,
      password: password || undefined,
    })
    session.flows = res.flows
    session.project.liveUrl = res.liveUrl
    render(session.flows)
    syncOpenSiteButton()
    const failed = res.flows.flatMap((flow) => flow.steps).find((step) => step.shotError && !step.shotId)
    setStatus(failed ? failed.shotError : res.liveUrl ? `Running at ${res.liveUrl}` : '', Boolean(failed))
    await loadPreflight()
  } catch (err) {
    setStatus(err.message, true)
  } finally {
    capturing = false
  }
}

openSiteBtn?.addEventListener('click', () => {
  const live = session?.project?.liveUrl
  if (!live) return
  window.open(live, '_blank', 'noopener,noreferrer')
})

mapBtn.onclick = async () => {
  const folder = pathInput.value.trim()
  if (!folder) return setDialogStatus('Choose a project folder.', true)
  mapBtn.disabled = true
  setDialogStatus('Reading the project and tracing paths…')
  try {
    session = await post('/api/map', { path: folder })
    resetPreflight()
    activeId = session.flows[0]?.id ?? null
    choices.changes = {}
    metricsBoard = null
    if (!session.stats.screens) {
      setDialogStatus('No pages found. FlowMap looks for app/page, pages/, or router paths — including inside frontend/ or web/.', true)
      return
    }
    render(session.flows)
    openDialog.close()
    setDialogStatus('')
    setStatus(`${session.stats.screens} screens`)
    await Promise.all([captureVisuals(), presentAnalytics(), loadPreflight()])
  } catch (err) {
    setDialogStatus(err.message, true)
  } finally {
    mapBtn.disabled = false
  }
}

visitsToggle.onclick = () => {
  const open = visitsPanel.hidden
  visitsPanel.hidden = !open
  visitsToggle.setAttribute('aria-expanded', String(open))
}

document.addEventListener('click', (event) => {
  if (!visits.contains(event.target)) {
    visitsPanel.hidden = true
    visitsToggle.setAttribute('aria-expanded', 'false')
  }
})

const MM = 96 / 25.4
const PAGE_W = 168 * MM
const PAGE_H = 246 * MM

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not load a screenshot'))
    img.src = src
  })
}

function sliceShot(img, firstPx, restPx) {
  const scale = PAGE_W / img.naturalWidth
  const parts = []
  let y = 0
  let first = true
  while (y < img.naturalHeight) {
    const display = first ? firstPx : restPx
    const srcH = Math.max(1, Math.min(img.naturalHeight - y, Math.floor(display / scale)))
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = srcH
    canvas.getContext('2d').drawImage(img, 0, y, img.naturalWidth, srcH, 0, 0, img.naturalWidth, srcH)
    parts.push(canvas.toDataURL('image/jpeg', 0.86))
    y += srcH
    first = false
  }
  return parts
}

function stepTitle(flow, step) {
  if (step.kind === 'happy') return step.name
  return sourceStep(flow, step)?.name || step.route || step.name
}

async function buildDocument() {
  const project = session.project?.name || 'Untitled project'
  const when = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
  doc.replaceChildren()

  const cover = el('header', 'doc-cover')
  cover.append(el('p', 'doc-kicker', 'FlowMap'))
  cover.append(el('h1', null, project))
  const live = session.project?.liveUrl ? ` · captured from ${session.project.liveUrl}` : ''
  cover.append(el('p', 'doc-sub', `Path map · ${when}${live}`))
  const toc = el('ol', 'doc-toc')
  session.flows.forEach((flow, index) => {
    const happy = flow.steps.filter((s) => s.kind === 'happy').sort((a, b) => a.col - b.col)
    const li = el('li')
    li.append(el('span', 'doc-num', String(index + 1).padStart(2, '0')))
    li.append(el('span', 'doc-toc-name', flow.name))
    li.append(el('span', 'doc-toc-path', happy.map((s) => s.route || s.name).join('  →  ')))
    toc.append(li)
  })
  cover.append(toc)
  doc.append(cover)

  for (const [index, flow] of session.flows.entries()) {
    const section = el('section', 'doc-journey')
    section.append(el('p', 'doc-kicker', `Journey ${String(index + 1).padStart(2, '0')}`))
    section.append(el('h2', null, flow.name))
    const happy = flow.steps.filter((s) => s.kind === 'happy').sort((a, b) => a.col - b.col)
    section.append(el('p', 'doc-chain', happy.map((s) => s.name).join('  →  ')))
    const flowStats = metricsBoard?.flows?.find((item) => item.id === flow.id)
    if (flowStats?.headline || flowStats?.finish) {
      section.append(el('p', 'doc-stat', [flowStats.headline, flowStats.finish].filter(Boolean).join(' · ')))
    }
    const summary = summaryLine(flowStats?.summary)
    if (summary) section.append(el('p', 'doc-stat', summary))
    for (const note of flowStats?.notes || []) section.append(el('p', 'doc-note', note))

    for (const lane of flow.lanes) {
      const steps = flow.steps.filter((s) => s.laneId === lane.id).sort((a, b) => a.col - b.col)
      if (!steps.length) continue
      const block = el('div', 'doc-lane')
      block.append(el('h3', null, lane.kind === 'happy' ? 'Happy path' : lane.name))
      if (lane.kind !== 'happy') {
        const from = sourceStep(flow, steps[0])
        if (from) block.append(el('p', 'doc-from', `From ${from.name}`))
      }
      for (const [stepIndex, step] of steps.entries()) {
        const title = stepTitle(flow, step)
        const parts = step.shotId ? sliceShot(await loadImage(`/shots/${step.shotId}`), PAGE_H - 86, PAGE_H - 36) : [null]
        parts.forEach((src, part) => {
          const chunk = el('div', part === 0 ? 'doc-chunk' : 'doc-chunk doc-chunk-next')
          if (part === 0) {
            const head = el('header', 'doc-step-head')
            head.append(el('span', 'doc-num', String(stepIndex + 1).padStart(2, '0')))
            const titles = el('div')
            titles.append(el('h4', null, title))
            if (step.route) titles.append(el('p', 'doc-route', step.route))
            if (step.kind !== 'happy' && step.name !== title) titles.append(el('p', 'doc-evidence', step.name))
            else if (step.evidence) titles.append(el('p', 'doc-evidence', step.evidence))
            for (const line of statTexts(step, flow)) titles.append(el('p', 'doc-stat', line))
            head.append(titles)
            chunk.append(head)
          } else {
            chunk.append(el('p', 'doc-continued', `${title} · continued`))
          }
          if (src) {
            const fig = el('figure', 'doc-shot')
            const img = document.createElement('img')
            img.src = src
            img.alt = part === 0 ? title : `${title}, continued`
            fig.append(img)
            chunk.append(fig)
          } else {
            chunk.append(el('p', 'doc-missing', step.shotError || 'No capture for this screen. Capture visuals to include it.'))
          }
          block.append(chunk)
        })
      }
      section.append(block)
    }
    doc.append(section)
  }
}

pdfBtn.onclick = async () => {
  if (!session?.flows?.length) return
  pdfBtn.disabled = true
  setStatus('Preparing the document…')
  const previous = document.title
  try {
    await buildDocument()
    document.title = `${session.project?.name || 'FlowMap'} — paths`
    const done = () => {
      document.title = previous
      window.removeEventListener('afterprint', done)
    }
    window.addEventListener('afterprint', done)
    window.print()
    setStatus('')
  } catch (err) {
    setStatus(err.message, true)
  } finally {
    pdfBtn.disabled = false
  }
}

figmaBtn.onclick = () => help.showModal()

async function startGoogleConnect({ forceAccountPicker = false } = {}) {
  try {
    await refreshGoogle()
    if (!googleStatus.configured) {
      document.querySelector('#google-redirect').textContent = googleStatus.redirect
      document.querySelector('#google-setup-status').textContent = ''
      document.querySelector('#google-setup').showModal()
      return
    }
    // Already signed in, just missing a site for this project — open the picker.
    if (googleStatus.connected && !forceAccountPicker) {
      await afterConnect()
      return
    }
    if (googleStatus.connected) await post('/api/google/disconnect')
    await post('/api/google/start')
    setAnalyticsNote('Approve access in the Google window…')
    pollConnect()
  } catch (err) {
    setAnalyticsNote(err.message, true)
  }
}

connectBtn.onclick = () => startGoogleConnect()
switchBtn.onclick = () => startGoogleConnect({ forceAccountPicker: true })

deviceSelect.onchange = () => {
  choices.device = deviceSelect.value
  if (googleStatus.property) loadMetrics()
}

sourceSelect.onchange = () => {
  choices.source = sourceSelect.value
  if (googleStatus.property) loadMetrics()
}

document.querySelector('#google-save').onclick = () => document.querySelector('#google-json').click()

document.querySelector('#google-json').onchange = async (event) => {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  const note = document.querySelector('#google-setup-status')
  note.classList.remove('error')
  note.textContent = 'Saving the client…'
  try {
    const client = JSON.parse(await file.text())
    await post('/api/google/client', { client })
    document.querySelector('#google-setup').close()
    googleStatus = { ...googleStatus, configured: true }
    await post('/api/google/start')
    setAnalyticsNote('Approve access in the Google window…')
    pollConnect()
  } catch (err) {
    note.textContent = err.message
    note.classList.add('error')
  }
}

document.querySelector('#site-save').onclick = async () => {
  const selected = document.querySelector('#site-list input:checked')?.value
  if (!selected) return
  try {
    const res = await post('/api/google/choose', { property: selected })
    googleStatus = { ...googleStatus, connected: true, property: res.property }
    document.querySelector('#site-pick').close()
    paintAnalytics()
    await loadMetrics()
  } catch (err) {
    setAnalyticsNote(err.message, true)
  }
}

document.querySelector('#download-json').onclick = async (event) => {
  event.preventDefault()
  const res = await fetch('/api/figma')
  const json = await res.json()
  const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${(session?.project?.name || 'flowmap').replace(/\s+/g, '-')}-flows.json`
  a.click()
  URL.revokeObjectURL(a.href)
  help.close()
}
