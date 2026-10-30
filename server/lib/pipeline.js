import { captureRoutes, ensureServer, projectName } from './capture.js'
import { detectAnalytics } from './analytics/detect.js'
import { attachChanges } from './analytics/changes.js'
import { assemble, detectFramework, mapProject } from './map.js'
import { readPackage, readProject } from './readProject.js'

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

/** Read a project folder and lay its screens out as journeys. */
export function mapFolder(folder) {
  const pkg = readPackage(folder)
  const files = readProject(folder)
  const framework = detectFramework(pkg, files)
  const analytics = detectAnalytics(files, folder)
  const map = mapProject(files, framework.id)
  const flows = assemble(map)
  attachChanges(folder, flows)
  const { events, ...publicAnalytics } = analytics
  return {
    project: { path: folder, name: projectName(folder, pkg), framework: framework.name, frameworkId: framework.id, guessedUrl: framework.url, analytics: publicAnalytics },
    map,
    flows,
    events,
    stats: { files: Object.keys(files).length, screens: map.screens.length, links: map.links.length },
  }
}

/**
 * Screenshot every route in the flows and attach each image to its step.
 * `onShot(step, buffer)` stores the image and returns the id the step should point at.
 */
export async function captureFlows(project, flows, { url, viewport, onShot } = {}) {
  const handle = await ensureServer(project.path, { id: project.frameworkId }, url)
  const routes = [...new Set(flows.flatMap((f) => f.steps.map((s) => s.route).filter(Boolean)))]
  const taken = await captureRoutes(handle.url, routes, { viewport })
  for (const flow of flows) {
    for (const step of flow.steps) {
      const original = step.route
      const concrete = taken.resolved[original]
      const shot = taken.images[original]
      if (concrete && !concrete.fallback && concrete.path !== original) {
        step.route = concrete.path
        step.resolvedFrom = original
      }
      if (Buffer.isBuffer(shot)) {
        step.shotId = onShot ? onShot(step, shot) : undefined
        step.shotW = shot.readUInt32BE(16)
        step.shotH = shot.readUInt32BE(20)
        step.shotError = undefined
      } else if (shot && shot.error) {
        step.shotError = shot.error
      }
    }
    dropUnvisited(flow)
  }
  return { liveUrl: handle.url, handle, images: taken.images, resolved: taken.resolved }
}

/** Screens with the lane they sit in, for tools that only need a list (such as designer-preflight). */
export function screenList(mapped) {
  const lanesByRoute = new Map()
  for (const flow of mapped.flows) {
    for (const step of flow.steps) {
      const lane = flow.lanes.find((l) => l.id === step.laneId)
      if (!step.route || lanesByRoute.has(step.route)) continue
      lanesByRoute.set(step.route, flow.id === 'other' ? 'Other screens' : lane?.name || 'Happy path')
    }
  }
  return mapped.map.screens.map((s) => ({ route: s.route, name: s.name, pattern: s.pattern, entry: s.entry, lane: lanesByRoute.get(s.route) || 'Other screens' }))
}
