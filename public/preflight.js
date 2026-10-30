/** Pre-flight panel: results from designer-preflight, approvals, before/after pictures and AI agent runs. */

const BADGES = { errors: 'Errors', access: 'Access', mobile: 'Phones', security: 'Security', speed: 'Speed', tidy: 'Tidy' }
const VERDICT = {
  'NO-SHIP': { title: 'Not ready to share yet', text: 'At least one problem could expose data, cost money, or break the site for many people.' },
  'PASS WITH RISKS': { title: 'Ready to share, with care', text: 'Nothing is blocking, but some problems are worth fixing soon.' },
  PASS: { title: 'Ready to share', text: 'The automatic checks found nothing serious. Try it on your own phone before you announce it.' },
}
const GROUPS = [
  { title: 'Fix before you share', test: (f) => f.severity === 'P0' && f.confidence !== 'human-only' },
  { title: 'Fix soon', test: (f) => f.severity === 'P1' && f.confidence !== 'human-only' },
  { title: 'Tidy up when you can', test: (f) => f.severity === 'P2' && f.confidence !== 'human-only' },
  { title: 'Needs your judgement', test: (f) => f.confidence === 'human-only' },
]
const SIZES = { iphone: 'iPhone', android: 'Android', tablet: 'Tablet', desktop: 'Desktop' }

const panel = document.querySelector('#preflight')
const checkBtn = document.querySelector('#check')
const body = document.querySelector('#preflight-body')
const verdictEl = document.querySelector('#preflight-verdict')
const summaryEl = document.querySelector('#preflight-summary')
const statusEl = document.querySelector('#preflight-status')
const logEl = document.querySelector('#preflight-log')
const agentSelect = document.querySelector('#agent')
const proposeBtn = document.querySelector('#agent-propose')
const applyBtn = document.querySelector('#agent-apply')

let state = null
let ctx = null
let screenFilter = null
let running = null

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

async function getJson(url) {
  const res = await fetch(url)
  return res.json()
}

async function post(url, data) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data ?? {}) })
  const json = await res.json()
  if (json.ok === false && !json.notInstalled) throw new Error(json.error || 'Something went wrong')
  return json
}

function setStatus(text, error = false) {
  statusEl.textContent = text || ''
  statusEl.classList.toggle('error', error)
}

function live(f) {
  return f.status !== 'fixed'
}

/** Badge counts for one card on the board, or null when there is nothing to show. */
export function badgeRow(step) {
  const counts = state?.badges?.byStep?.[step.id]
  if (!counts) return null
  const shown = Object.keys(BADGES).filter((k) => counts[k])
  if (!shown.length) return null
  const row = el('div', 'pf-badges')
  for (const kind of shown) {
    const button = el('button', `pf-badge ${counts.worst === 'P0' ? 'p0' : counts.worst === 'P1' ? 'p1' : 'p2'}`, `${counts[kind]} ${BADGES[kind]}`)
    button.type = 'button'
    button.title = `See the ${BADGES[kind].toLowerCase()} problems on this screen`
    button.onclick = (event) => {
      event.stopPropagation()
      openPanel({ keys: counts.keys, name: step.name })
    }
    row.append(button)
  }
  return row
}

export function badgeHeight(step) {
  return badgeRow(step) ? 30 : 0
}

function findingCard(f) {
  const card = el('article', `pf-finding ${f.severity.toLowerCase()} ${f.status}`)
  card.append(el('h4', null, f.what))
  card.append(el('p', null, f.why))
  if (f.fix) {
    const fix = el('p', 'pf-fix')
    fix.append(el('strong', null, 'How to fix: '), document.createTextNode(f.fix))
    card.append(fix)
  }
  const meta = [f.effort && `About ${f.effort}`, f.screens?.length > 1 ? `${f.screens.length} screens` : f.screen, f.file && `${f.file}${f.line ? `:${f.line}` : ''}`, f.confidence === 'needs-human' && 'Worth a human look'].filter(Boolean)
  if (meta.length) card.append(el('p', 'pf-meta', meta.join(' · ')))
  if (f.evidence) {
    const details = el('details', 'pf-details')
    details.append(el('summary', null, 'Details for developers'), el('pre', null, f.evidence))
    card.append(details)
  }

  const actions = el('div', 'pf-actions')
  const decide = async (status, note) => {
    try {
      await post('/api/preflight/mark', { keys: [f.key], status, note })
      await loadPreflight()
    } catch (err) {
      setStatus(err.message, true)
    }
  }
  if (f.status === 'open') {
    const approve = el('button', 'primary', 'Fix this')
    approve.type = 'button'
    approve.onclick = () => decide('approved')
    const accept = el('button', null, 'It’s fine as it is')
    accept.type = 'button'
    accept.onclick = () => {
      actions.replaceChildren()
      const input = el('input')
      input.placeholder = 'Why is it fine? (optional, helps whoever reads this next)'
      const save = el('button', 'primary', 'Save')
      save.type = 'button'
      save.onclick = () => decide('accepted-risk', input.value.trim() || 'Accepted in FlowMap')
      actions.append(input, save)
      input.focus()
    }
    actions.append(approve, accept)
  } else {
    actions.append(el('span', 'pf-state', f.status === 'approved' ? 'Will be fixed' : f.status === 'accepted-risk' ? `Accepted${f.note ? `: ${f.note}` : ''}` : f.status))
    const undo = el('button', null, 'Undo')
    undo.type = 'button'
    undo.onclick = () => decide('open')
    actions.append(undo)
  }
  card.append(actions)
  return card
}

function compareSection() {
  const diff = state?.diff
  if (!diff) return null
  const section = el('section', 'pf-section')
  section.append(el('h3', null, diff.changed ? `What changed since the “before” pictures (${diff.changed} of ${diff.compared})` : 'Nothing changed on screen since the “before” pictures'))
  if (diff.changed) section.append(el('p', 'pf-intro', 'Red marks show exactly what changed. Check each one is a change you wanted.'))
  for (const change of diff.changes.slice(0, 24)) {
    const row = el('div', 'pf-compare')
    row.append(el('p', 'pf-meta', `${change.route} on ${SIZES[change.size] || change.size}: ${change.note || `${change.changed}% of the screen changed`}`))
    const images = el('div', 'pf-images')
    for (const [label, rel] of [['Before', change.before], ['After', change.after], ['Changes', change.diff]]) {
      if (!rel) continue
      const figure = el('figure')
      const src = `/api/preflight/shot?path=${encodeURIComponent(rel.replace(/^\.preflight\//, ''))}`
      const link = el('a')
      link.href = src
      link.target = '_blank'
      link.rel = 'noopener'
      link.title = 'Open the full picture'
      const img = el('img')
      img.loading = 'lazy'
      img.alt = `${label}: ${change.route} on ${SIZES[change.size] || change.size}`
      img.src = src
      link.append(img)
      figure.append(link, el('figcaption', null, label))
      images.append(figure)
    }
    row.append(images)
    section.append(row)
  }
  return section
}

function renderPanel() {
  body.replaceChildren()
  if (!state?.installed && !state?.scanned) {
    verdictEl.textContent = 'Designer Preflight is not installed'
    summaryEl.textContent = 'Designer Preflight checks your project for security, accessibility, phone and leftover problems. Install it, then press Check again.'
    const link = el('a', null, 'How to install Designer Preflight')
    link.href = 'https://github.com/noellyonsgit/designer-preflight#get-started'
    link.target = '_blank'
    link.rel = 'noopener'
    body.append(link)
    return
  }
  if (!state?.scanned) {
    verdictEl.textContent = 'Not checked yet'
    summaryEl.textContent = 'Press “Run checks” to check every screen. It takes one to five minutes and changes nothing in your project.'
    return
  }
  const v = VERDICT[state.verdict]
  verdictEl.textContent = v.title
  verdictEl.dataset.verdict = state.verdict
  const open = state.findings.filter(live)
  const count = (sev) => open.filter((f) => f.severity === sev && f.status !== 'accepted-risk').length
  summaryEl.textContent = `${v.text} ${count('P0')} to fix before sharing, ${count('P1')} to fix soon, ${count('P2')} to tidy up.`

  if (screenFilter) {
    const bar = el('div', 'pf-filter')
    bar.append(el('span', null, `Showing problems on ${screenFilter.name}`))
    const all = el('button', null, 'Show everything')
    all.type = 'button'
    all.onclick = () => {
      screenFilter = null
      renderPanel()
    }
    bar.append(all)
    body.append(bar)
  }

  const compare = compareSection()
  if (compare && !screenFilter) body.append(compare)

  const visible = open.filter((f) => !screenFilter || screenFilter.keys.includes(f.key))
  for (const group of GROUPS) {
    const items = visible.filter((f) => group.test(f) && f.status !== 'accepted-risk')
    if (!items.length) continue
    const section = el('section', 'pf-section')
    section.append(el('h3', null, `${group.title} (${items.length})`))
    items.forEach((f) => section.append(findingCard(f)))
    body.append(section)
  }
  const accepted = visible.filter((f) => f.status === 'accepted-risk')
  if (accepted.length) {
    const details = el('details', 'pf-section')
    details.append(el('summary', null, `Things you said are fine (${accepted.length})`))
    accepted.forEach((f) => details.append(findingCard(f)))
    body.append(details)
  }
  const fixed = state.findings.filter((f) => f.status === 'fixed')
  if (fixed.length && !screenFilter) {
    const details = el('details', 'pf-section')
    details.append(el('summary', null, `Already fixed (${fixed.length})`))
    const list = el('ul')
    fixed.forEach((f) => list.append(el('li', null, f.what)))
    details.append(list)
    body.append(details)
  }
  if (state.notChecked?.length && !screenFilter) {
    const details = el('details', 'pf-section')
    details.append(el('summary', null, 'What was not checked'))
    const list = el('ul')
    state.notChecked.forEach((item) => list.append(el('li', null, item)))
    details.append(list)
    body.append(details)
  }
  const approved = state.findings.filter((f) => f.status === 'approved').length
  applyBtn.textContent = approved ? `Fix what I approved (${approved})` : 'Fix what I approved'
  applyBtn.disabled = !approved || Boolean(running) || !agentSelect.value
}

function updateCheckButton() {
  if (!checkBtn) return
  checkBtn.disabled = !ctx?.getSession()?.project
  checkBtn.textContent = state?.scanned ? `Check · ${state.verdict === 'PASS' ? 'Ready' : state.verdict === 'NO-SHIP' ? 'Not ready' : 'With care'}` : 'Check'
  checkBtn.dataset.verdict = state?.verdict || ''
}

export async function loadPreflight() {
  if (!ctx?.getSession()?.project) return
  try {
    state = await getJson('/api/preflight')
  } catch {
    state = null
  }
  updateCheckButton()
  if (panel.open) renderPanel()
  ctx.rerender()
}

export function resetPreflight() {
  state = null
  screenFilter = null
  updateCheckButton()
}

function openPanel(filter) {
  screenFilter = filter || null
  renderPanel()
  if (!panel.open) panel.showModal()
}

async function follow(jobId, label) {
  running = jobId
  logEl.hidden = false
  logEl.textContent = ''
  setStatus(label)
  renderPanel()
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500))
    const { job } = await getJson(`/api/jobs?id=${encodeURIComponent(jobId)}`)
    if (!job) break
    logEl.textContent = job.log.trim().split('\n').slice(-12).join('\n')
    if (job.status === 'running') continue
    running = null
    setStatus(job.status === 'done' ? '' : job.error || 'It stopped before finishing.', job.status !== 'done')
    await loadPreflight()
    return job
  }
  running = null
  return null
}

async function startCli(url, label) {
  try {
    const res = await post(url, {})
    if (res.notInstalled) {
      state = { installed: false, scanned: false }
      return renderPanel()
    }
    await follow(res.jobId, label)
  } catch (err) {
    setStatus(err.message, true)
  }
}

async function loadAgents() {
  try {
    const { agents } = await getJson('/api/agents')
    agentSelect.replaceChildren()
    for (const agent of agents) {
      const option = el('option', null, agent.available ? agent.label : `${agent.label} (${agent.note})`)
      option.value = agent.id
      option.disabled = !agent.available
      agentSelect.append(option)
    }
    const first = agents.find((a) => a.available)
    if (first) agentSelect.value = first.id
    proposeBtn.disabled = !first
  } catch {
    proposeBtn.disabled = true
  }
}

async function runAgent(mode) {
  try {
    const res = await post('/api/agents/run', { agent: agentSelect.value, mode })
    const job = await follow(res.jobId, mode === 'propose' ? 'The AI agent is reviewing the project. It will not change anything.' : 'The AI agent is fixing what you approved, one group at a time.')
    if (job?.warning) setStatus(job.warning, true)
    else if (job?.status === 'done' && mode === 'propose') setStatus('Review finished. Anything new the agent found is in the list below.')
    else if (job?.status === 'done' && mode === 'apply') setStatus('Done. Compare with your “before” pictures, then merge the preflight branch when you are happy.')
  } catch (err) {
    setStatus(err.message, true)
  }
}

export function initPreflight(options) {
  ctx = options
  checkBtn.onclick = () => {
    openPanel()
    if (!state?.scanned && state?.installed !== false) startCli('/api/preflight/scan', 'Checking every screen. This takes one to five minutes and changes nothing.')
  }
  document.querySelector('#preflight-scan').onclick = () => startCli('/api/preflight/scan', 'Checking every screen. This takes one to five minutes and changes nothing.')
  document.querySelector('#preflight-baseline').onclick = () => startCli('/api/preflight/baseline', 'Taking “before” pictures of every screen at phone, tablet and desktop sizes…')
  document.querySelector('#preflight-compare').onclick = () => startCli('/api/preflight/compare', 'Taking new pictures and comparing them with the “before” pictures…')
  proposeBtn.onclick = () => runAgent('propose')
  applyBtn.onclick = () => runAgent('apply')
  agentSelect.onchange = renderPanel
  loadAgents()
}
