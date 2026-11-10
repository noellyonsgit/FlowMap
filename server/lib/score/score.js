/**
 * Tier 1 Pack A ease-of-use scoring — deterministic checks on the mapped graph.
 * Methodology: KLM/GOMS for path length and operator time; Nielsen heuristics
 * for error resilience, consistency, and recovery (structural proxies only).
 */

const WEIGHTS = {
  completion: 0.25,
  time: 0.2,
  information: 0.15,
  resilience: 0.15,
  consistency: 0.15,
  recovery: 0.1,
}

const KLM = {
  screen: 1.2,
  scroll: 1.1,
  form: 4.5,
  decision: 1.2,
}

function clampScore(raw) {
  return Math.min(5, Math.max(1, Math.round(raw)))
}

function happySteps(flow) {
  return flow.steps.filter((step) => step.kind === 'happy').sort((a, b) => a.col - b.col)
}

function evidenceOf(step, detail) {
  return {
    stepId: step?.id,
    edgeId: undefined,
    entry: step?.entry,
    file: step?.evidence?.split(':')[0],
    line: step?.evidence?.includes(':') ? Number(step.evidence.split(':').pop()) : undefined,
    detail,
  }
}

function check(id, status, ordinal, evidence = [], reading = '') {
  return { id, status, ordinal, evidence, reading }
}

function dimensionScore(checks) {
  const usable = checks.filter((item) => item.status !== 'unavailable')
  if (!usable.length) return { score: null, confidence: 'low', checks }
  const raw = 3 + usable.reduce((sum, item) => sum + (item.ordinal || 0), 0)
  const half = Math.ceil(checks.length / 2)
  return {
    score: clampScore(raw),
    confidence: usable.length < half ? 'low' : 'high',
    checks,
  }
}

function completionChecks(flow) {
  const happy = happySteps(flow)
  const L = happy.length
  const conditional = flow.edges.filter((edge) => edge.label === 'if')
  const edgeSteps = flow.steps.filter((step) => step.kind === 'edge')
  const mid = Math.floor(L / 2)
  const earlyUnhappy = flow.steps.filter((step) => {
    if (step.kind !== 'unhappy') return false
    const from = flow.edges.find((edge) => edge.to === step.id)
    const source = happy.find((item) => item.id === from?.from)
    return source && source.col < mid
  })

  const c1 =
    L <= 3 ? 2 : L <= 5 ? 1 : L <= 8 ? 0 : -1
  const density = L > 1 ? conditional.length / (L - 1) : 0
  const c2 = density === 0 ? 2 : density <= 0.25 ? 1 : density <= 0.5 ? 0 : -1
  const c3 = edgeSteps.length === 0 ? 1 : edgeSteps.length <= 2 ? 0 : -1
  const c4 = earlyUnhappy.length ? 0 : 1

  const pathNames = happy.map((step) => step.name).filter(Boolean)
  const pathList = pathNames.length ? pathNames.join(' → ') : 'this path'
  return dimensionScore([
    check(
      'C1',
      'pass',
      c1,
      happy.map((step) => evidenceOf(step, `Happy step · col ${step.col}`)),
      L <= 3
        ? `Short path — ${L} screen${L === 1 ? '' : 's'} to finish (${pathList}).`
        : L <= 5
          ? `Moderate path — ${L} screens (${pathList}).`
          : L <= 8
            ? `Long path — ${L} screens before finish.`
            : `Very long path — ${L} screens, which makes completion harder.`,
    ),
    check(
      'C2',
      conditional.length ? (c2 >= 1 ? 'pass' : 'fail') : 'pass',
      c2,
      conditional.map((edge) => ({ edgeId: edge.id, detail: 'Conditional branch' })),
      conditional.length === 0
        ? 'No conditional branches on the way — one clear route.'
        : c2 >= 1
          ? `A few decision points (${conditional.length}) along the path.`
          : `Many decision points (${conditional.length}) relative to the path length.`,
    ),
    check(
      'C3',
      edgeSteps.length > 2 ? 'fail' : 'pass',
      c3,
      edgeSteps.map((step) => evidenceOf(step, 'Branch screen')),
      edgeSteps.length === 0
        ? 'No side-branch screens pulling people off the main path.'
        : edgeSteps.length <= 2
          ? `${edgeSteps.length === 1 ? 'One' : 'Two'} branch screen${edgeSteps.length === 1 ? '' : 's'} sit beside the main path.`
          : `${edgeSteps.length} branch screens sit beside the main path.`,
    ),
    check(
      'C4',
      earlyUnhappy.length ? 'fail' : 'pass',
      c4,
      earlyUnhappy.map((step) => evidenceOf(step, step.state || step.name)),
      earlyUnhappy.length
        ? `Problems show up early — for example “${earlyUnhappy[0].state || earlyUnhappy[0].name}”.`
        : 'No early dead-ends before the middle of the path.',
    ),
  ])
}

function timeChecks(flow) {
  const happy = happySteps(flow)
  let seconds = 0
  const evidence = []
  for (const step of happy) {
    seconds += KLM.screen
    evidence.push(evidenceOf(step, `Enter screen (+${KLM.screen}s)`))
    if (step.gestures?.includes('Scroll')) {
      seconds += KLM.scroll
      evidence.push(evidenceOf(step, `Scroll (+${KLM.scroll}s)`))
    }
    if (step.gestures?.includes('Form')) {
      seconds += KLM.form
      evidence.push(evidenceOf(step, `Form (+${KLM.form}s flat)`))
    }
  }
  for (const edge of flow.edges.filter((item) => item.label === 'if')) {
    seconds += KLM.decision
    evidence.push({ edgeId: edge.id, detail: `Decision (+${KLM.decision}s)` })
  }
  const t1 = seconds <= 8 ? 2 : seconds <= 15 ? 1 : seconds <= 25 ? 0 : -1
  const secs = Math.round(seconds)
  return dimensionScore([
    check(
      'T1',
      t1 >= 1 ? 'pass' : t1 === 0 ? 'partial' : 'fail',
      t1,
      [...evidence, { detail: `KLM total ${seconds.toFixed(1)}s` }],
      secs <= 8
        ? `Estimated operator time is short — about ${secs} seconds on the happy path.`
        : secs <= 15
          ? `Estimated operator time is moderate — about ${secs} seconds.`
          : secs <= 25
            ? `Estimated operator time is getting long — about ${secs} seconds.`
            : `Estimated operator time is high — about ${secs} seconds of screens, forms, and decisions.`,
    ),
    check('T2', 'unavailable', 0, [{ detail: 'No alternate reconnecting paths in Pack A' }], ''),
    check('T3', 'unavailable', 0, [{ detail: 'Detour tax needs return edges' }], ''),
  ])
}

function informationChecks(flow) {
  const happy = happySteps(flow)
  if (!happy.length) return dimensionScore([check('I1', 'unavailable', 0), check('I4', 'unavailable', 0)])
  const lastCol = happy[happy.length - 1].col
  const forms = happy.filter((step) => step.gestures?.includes('Form') && step.col < lastCol)
  const i1 = forms.length === 0 ? 2 : forms.length === 1 ? 1 : forms.length === 2 ? 0 : -1
  const mid = Math.floor(happy.length / 2)
  const gates = flow.steps.filter((step) => {
    if (step.kind !== 'unhappy') return false
    const from = flow.edges.find((edge) => edge.to === step.id)
    const source = happy.find((item) => item.id === from?.from)
    if (!source || source.col >= mid) return false
    const kind = step.stateKind || ''
    return kind === 'auth' || kind === 'empty' || /sign in|log in|empty|nothing here/i.test(step.state || step.name || '')
  })
  const i4 = gates.length === 0 ? 1 : gates.length === 1 ? 0 : -1
  return dimensionScore([
    check(
      'I1',
      forms.length >= 3 ? 'fail' : 'pass',
      i1,
      forms.map((step) => evidenceOf(step, 'Form before finish')),
      forms.length === 0
        ? 'No forms before the finish screen.'
        : forms.length === 1
          ? `One form before finish — on ${forms[0].name}.`
          : forms.length === 2
            ? `Two forms before finish — ${forms.map((step) => step.name).join(' and ')}.`
            : `${forms.length} forms before finish, which raises the information burden.`,
    ),
    check('I2', 'unavailable', 0, [{ detail: 'Field counts need Pack B extractor' }], ''),
    check('I3', 'unavailable', 0, [{ detail: 'Defaults need Pack B extractor' }], ''),
    check(
      'I4',
      gates.length >= 2 ? 'fail' : 'pass',
      i4,
      gates.map((step) => evidenceOf(step, step.state || step.name)),
      gates.length === 0
        ? 'No early gate screens (sign-in or empty states) blocking value.'
        : gates.length === 1
          ? `One early gate — “${gates[0].state || gates[0].name}”.`
          : `${gates.length} early gates before the middle of the path.`,
    ),
  ])
}

function resilienceChecks(flow) {
  const happy = happySteps(flow)
  const risky = happy.filter((step) => step.gestures?.includes('Form'))
  const covered = risky.filter((step) => flow.edges.some((edge) => edge.from === step.id && flow.steps.find((item) => item.id === edge.to)?.kind === 'unhappy'))
  const ratio = risky.length ? covered.length / risky.length : 1
  const e1 = ratio >= 0.8 ? 2 : ratio >= 0.5 ? 1 : 0
  const unhappy = flow.steps.filter((step) => step.kind === 'unhappy')
  const withCue = unhappy.filter((step) => /try again|go back|retry|fix|back to/i.test(step.state || step.name || ''))
  const e4 = !unhappy.length ? 1 : withCue.length === unhappy.length ? 1 : 0
  const uncovered = risky.filter((step) => !covered.includes(step))
  return dimensionScore([
    check(
      'E1',
      risky.length ? (e1 >= 1 ? 'pass' : 'fail') : 'pass',
      e1,
      risky.map((step) => evidenceOf(step, covered.includes(step) ? 'Has unhappy child' : 'Form without unhappy branch')),
      !risky.length
        ? 'No forms on the happy path to leave people stuck.'
        : uncovered.length === 0
          ? 'Every form screen has a mapped “when it goes wrong” state.'
          : e1 >= 1
            ? `Some forms have error states; ${uncovered.map((step) => step.name).join(', ')} still look uncovered.`
            : `Forms without a clear error path: ${uncovered.map((step) => step.name).join(', ')}.`,
    ),
    check('E2', 'unavailable', 0, [{ detail: 'Severity coverage scored in Pack B' }], ''),
    check('E3', 'unavailable', 0, [{ detail: 'Destructive confirm needs Pack B extractor' }], ''),
    check(
      'E4',
      unhappy.length ? (e4 ? 'pass' : 'fail') : 'pass',
      e4,
      unhappy.map((step) => evidenceOf(step, withCue.includes(step) ? 'Recovery cue in copy' : 'No recovery cue')),
      !unhappy.length
        ? 'No unhappy states mapped on this journey.'
        : e4
          ? 'Unhappy copy points people toward recovery (try again, go back, and similar).'
          : 'Some unhappy states don’t clearly say how to recover.',
    ),
  ])
}

function routeTokens(route) {
  return String(route || '')
    .toLowerCase()
    .split('/')
    .filter(Boolean)
    .map((part) => part.replace(/\[[^\]]+\]/g, '*'))
}

function jaccard(a, b) {
  const left = new Set(a)
  const right = new Set(b)
  if (!left.size && !right.size) return 1
  let inter = 0
  for (const item of left) if (right.has(item)) inter += 1
  return inter / (left.size + right.size - inter)
}

function consistencyChecks(flow, flows) {
  const peers = flows.filter((item) => item.id !== flow.id)
  const tokens = routeTokens(happySteps(flow).map((step) => step.route).join('/'))
  let best = peers.length ? 0 : 1
  for (const peer of peers) {
    const other = routeTokens(happySteps(peer).map((step) => step.route).join('/'))
    best = Math.max(best, jaccard(tokens, other))
  }
  const s1 = best >= 0.5 ? 1 : 0

  const formCols = happySteps(flow).filter((step) => step.gestures?.includes('Form')).map((step) => step.col)
  const peerCols = peers.flatMap((peer) => happySteps(peer).filter((step) => step.gestures?.includes('Form')).map((step) => step.col))
  let s2 = 1
  if (formCols.length && peerCols.length) {
    const mean = [...formCols, ...peerCols].reduce((sum, n) => sum + n, 0) / (formCols.length + peerCols.length)
    const variance = [...formCols, ...peerCols].reduce((sum, n) => sum + (n - mean) ** 2, 0) / (formCols.length + peerCols.length)
    s2 = variance <= 1 ? 1 : 0
  }

  const unhappy = flow.steps.filter((step) => step.kind === 'unhappy')
  const siblings = unhappy.every((step) => {
    const edge = flow.edges.find((item) => item.to === step.id)
    return edge && flow.steps.some((item) => item.id === edge.from && item.kind === 'happy')
  })
  const s3 = !unhappy.length || siblings ? 1 : 0

  return dimensionScore([
    check(
      'S1',
      peers.length ? (s1 ? 'pass' : 'fail') : 'pass',
      s1,
      [{ detail: peers.length ? `Best peer route Jaccard ${best.toFixed(2)}` : 'Single flow' }],
      !peers.length
        ? 'Only one journey mapped — nothing to compare for consistency yet.'
        : s1
          ? 'Route naming looks similar to other journeys on the site.'
          : 'This journey’s routes look quite different from the others.',
    ),
    check(
      'S2',
      formCols.length && peerCols.length ? (s2 ? 'pass' : 'fail') : 'pass',
      s2,
      formCols.map((col) => ({ detail: `Form at col ${col}` })),
      !formCols.length || !peerCols.length
        ? 'Not enough forms across journeys to judge placement consistency.'
        : s2
          ? 'Forms sit at a similar depth as in other journeys.'
          : 'Forms appear at uneven depths compared with other journeys.',
    ),
    check(
      'S3',
      s3 ? 'pass' : 'fail',
      s3,
      unhappy.map((step) => evidenceOf(step, 'Unhappy attachment')),
      !unhappy.length
        ? 'No unhappy states to place.'
        : s3
          ? 'Unhappy states sit under the screen that causes them.'
          : 'Some unhappy states are not attached to their source screen.',
    ),
    check('S4', 'unavailable', 0, [{ detail: 'Component reuse needs Pack B import graph' }], ''),
  ])
}

function recoveryChecks(flow) {
  const happy = happySteps(flow)
  if (happy.length < 2) {
    return dimensionScore([
      check('R1', 'unavailable', 0, [{ detail: 'Escape edges need Pack B' }], ''),
      check('R2', 'unavailable', 0, [{ detail: 'Undo needs Pack B' }], ''),
      check('R3', 'pass', 1, [{ detail: 'Single-step path' }], 'Single-screen path — recovery between steps does not apply.'),
      check('R4', 'unavailable', 0, [{ detail: 'Confirm needs Pack B' }], ''),
    ])
  }
  let linked = 0
  for (let i = 1; i < happy.length; i++) {
    if (flow.edges.some((edge) => edge.from === happy[i - 1].id && edge.to === happy[i].id)) linked += 1
  }
  const ratio = linked / (happy.length - 1)
  const r3 = ratio >= 0.8 ? 1 : 0
  return dimensionScore([
    check('R1', 'unavailable', 0, [{ detail: 'Escape from unhappy needs Pack B' }], ''),
    check('R2', 'unavailable', 0, [{ detail: 'Undo needs Pack B' }], ''),
    check(
      'R3',
      r3 ? 'pass' : 'fail',
      r3,
      happy.slice(1).map((step, index) => evidenceOf(step, `Inbound from ${happy[index].name}`)),
      r3
        ? 'Happy-path screens are linked in order, so people can move forward step by step.'
        : 'Gaps in the happy-path chain — some screens are not clearly linked from the previous one.',
    ),
    check('R4', 'unavailable', 0, [{ detail: 'Confirm needs Pack B' }], ''),
  ])
}

function overallFor(dimensions) {
  let weight = 0
  let total = 0
  let low = false
  for (const [id, dim] of Object.entries(dimensions)) {
    if (dim.score == null) continue
    const w = WEIGHTS[id]
    weight += w
    total += dim.score * w
    if (dim.confidence === 'low') low = true
  }
  if (!weight) return { overall: null, confidence: 'low' }
  return { overall: clampScore(total / weight), confidence: low ? 'low' : 'high' }
}

/** Project non-journey map links onto steps that share screen names in this flow. */
export function projectLinks(flow, map) {
  const byName = new Map()
  for (const step of flow.steps) {
    if (step.kind === 'unhappy') continue
    if (!byName.has(step.name)) byName.set(step.name, step)
  }
  const primary = new Set(flow.edges.map((edge) => `${edge.from}->${edge.to}`))
  const links = []
  const seen = new Set()
  for (const link of map?.links || []) {
    const from = byName.get(link.from)
    const to = byName.get(link.to)
    if (!from || !to || from.id === to.id) continue
    const key = `${from.id}->${to.id}`
    if (primary.has(key) || seen.has(key)) continue
    seen.add(key)
    links.push({
      id: `link-${from.id}-${to.id}`,
      from: from.id,
      to: to.id,
      fromName: link.from,
      toName: link.to,
      conditional: Boolean(link.conditional),
      context: link.context || '',
    })
  }
  return links.sort((a, b) => a.id.localeCompare(b.id))
}

const DIM_TITLE = {
  completion: 'Getting through',
  time: 'Time on the path',
  information: 'How much to fill in',
  resilience: 'When things go wrong',
  consistency: 'Familiar patterns',
  recovery: 'Getting back on track',
}

function storyFor(overall, dimensions) {
  const readings = []
  for (const [id, dim] of Object.entries(dimensions)) {
    for (const item of dim.checks || []) {
      if (!item.reading || item.status === 'unavailable') continue
      readings.push({
        dimension: id,
        title: DIM_TITLE[id] || id,
        status: item.status,
        ordinal: item.ordinal || 0,
        reading: item.reading,
      })
    }
  }
  const helped = readings.filter((item) => item.status === 'pass' && item.ordinal >= 1).sort((a, b) => b.ordinal - a.ordinal)
  const held = readings
    .filter((item) => item.status === 'fail' || item.status === 'partial' || (item.status === 'pass' && item.ordinal <= 0))
    .sort((a, b) => a.ordinal - b.ordinal)
  const blurb =
    overall >= 4
      ? 'This journey looks structurally easy — short, clear, and mostly well covered.'
      : overall === 3
        ? 'This journey is workable, with a few structural things that make it harder than it needs to be.'
        : 'This journey has structural friction — length, forms, errors, or recovery are holding the score down.'
  return {
    blurb,
    helped: helped.slice(0, 6).map(({ title, reading }) => ({ title, reading })),
    held: held.slice(0, 6).map(({ title, reading }) => ({ title, reading })),
  }
}

export function scoreFlow(flow, flows = [flow]) {
  const dimensions = {
    completion: completionChecks(flow),
    time: timeChecks(flow),
    information: informationChecks(flow),
    resilience: resilienceChecks(flow),
    consistency: consistencyChecks(flow, flows),
    recovery: recoveryChecks(flow),
  }
  const { overall, confidence } = overallFor(dimensions)
  return {
    flowId: flow.id,
    name: flow.name,
    overall,
    confidence,
    story: storyFor(overall, dimensions),
    dimensions: Object.entries(dimensions).map(([id, dim]) => ({
      id,
      title: DIM_TITLE[id] || id,
      weight: WEIGHTS[id],
      score: dim.score,
      confidence: dim.confidence,
      checks: dim.checks,
    })),
    behavioural: null,
  }
}

export function scoreFlows(flows, map = null) {
  const list = flows || []
  for (const flow of list) {
    flow.links = projectLinks(flow, map)
  }
  const scored = list.map((flow) => scoreFlow(flow, list)).sort((a, b) => a.flowId.localeCompare(b.flowId))
  const overalls = scored.map((item) => item.overall).filter((n) => n != null)
  const histogram = [0, 0, 0, 0, 0]
  for (const score of overalls) histogram[score - 1] += 1
  const mean = overalls.length ? overalls.reduce((sum, n) => sum + n, 0) / overalls.length : null
  const sorted = [...overalls].sort((a, b) => a - b)
  const median = sorted.length
    ? sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : null

  const dimMeans = {}
  for (const id of Object.keys(WEIGHTS)) {
    const values = scored.map((flow) => flow.dimensions.find((dim) => dim.id === id)?.score).filter((n) => n != null)
    dimMeans[id] = {
      mean: values.length ? values.reduce((sum, n) => sum + n, 0) / values.length : null,
      lowConfidenceCount: scored.filter((flow) => flow.dimensions.find((dim) => dim.id === id)?.confidence === 'low').length,
    }
  }

  const checkFails = new Map()
  for (const flow of scored) {
    for (const dim of flow.dimensions) {
      for (const item of dim.checks) {
        if (item.status !== 'fail') continue
        if (!checkFails.has(item.id)) checkFails.set(item.id, [])
        checkFails.get(item.id).push(flow.flowId)
      }
    }
  }
  const patterns = [...checkFails.entries()]
    .filter(([, ids]) => ids.length >= 3 || ids.length / Math.max(scored.length, 1) >= 0.2)
    .map(([checkId, flowIds]) => ({
      checkId,
      failCount: flowIds.length,
      flowIds: [...flowIds].sort(),
      summary: `${checkId} failed in ${flowIds.length} flows`,
    }))
    .sort((a, b) => a.checkId.localeCompare(b.checkId))

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    weights: { ...WEIGHTS },
    estate: {
      flowCount: scored.length,
      overall: {
        mean: mean == null ? null : Math.round(mean * 10) / 10,
        median,
        histogram,
      },
      dimensions: dimMeans,
      flags: scored
        .filter((flow) => flow.overall != null && (flow.overall <= 2 || flow.dimensions.some((dim) => dim.score != null && dim.score <= 2)))
        .map((flow) => ({
          flowId: flow.flowId,
          overall: flow.overall,
          reasons: flow.dimensions.filter((dim) => dim.score != null && dim.score <= 2).map((dim) => `${dim.id} ${dim.score}`),
        })),
      patterns,
      correlation: { telemetry: null },
    },
    flows: scored,
  }
}
