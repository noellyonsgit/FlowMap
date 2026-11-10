import fs from 'node:fs'
import path from 'node:path'
import { captureRoutes, ensureServer, localFamilytreeCookies, localGhostCookies, projectName } from './capture.js'
import { detectAnalytics } from './analytics/detect.js'
import { attachChanges } from './analytics/changes.js'
import { assemble, buildFlow, detectFramework, mapProject, routePattern, screenLabel, shotKeyFor } from './map.js'

function entryRankPath(route) {
  const p = String(route || '')
  if (p === '/' || /^\/[^/]+$/.test(p)) return 0
  // Projects list is the real product home after the workspace shell.
  if (/\/projects\/?$/.test(p)) return 1
  if (/\/(issues|cycles|modules|pages|intake|views)(\/|$)/.test(p) && !/\/(settings|archives)\//.test(p)) return 2
  if (/\/(active-cycles|notifications|drafts)(\/|$)/.test(p)) return 3
  if (/\/(login|sign-up|onboarding|create-workspace)(\/|$)/.test(p)) return 4
  if (/\/(settings|billing|webhooks|exports|integrations)(\/|$)/.test(p)) return 6
  return 5
}

/** Plane keeps nav targets in runtime data — add a product spine so journeys read clearly. */
function seedPlaneLinks(map, slug, projectId) {
  const byRoute = new Map(map.screens.map((screen) => [screen.route, screen]))
  const spine = [
    `/${slug}`,
    `/${slug}/projects`,
    projectId ? `/${slug}/projects/${projectId}/issues` : null,
    projectId ? `/${slug}/projects/${projectId}/cycles` : null,
    projectId ? `/${slug}/projects/${projectId}/modules` : null,
    projectId ? `/${slug}/projects/${projectId}/pages` : null,
    projectId ? `/${slug}/projects/${projectId}/views` : null,
    projectId ? `/${slug}/projects/${projectId}/intake` : null,
    `/${slug}/active-cycles`,
    `/${slug}/analytics/overview`,
    `/${slug}/settings`,
  ].filter(Boolean)
  // Ensure the workspace shell exists even when route config was truncated out of the read set.
  if (!byRoute.has(`/${slug}`)) {
    const route = `/${slug}`
    const screen = { name: screenLabel(route), entry: `app/(all)/[workspaceSlug]/(projects)/page.tsx`, route, pattern: routePattern(route) }
    map.screens.unshift(screen)
    byRoute.set(route, screen)
  }
  const present = spine.filter((route) => byRoute.has(route))
  const seen = new Set(map.links.map((link) => `${link.from}->${link.to}`))
  for (let i = 0; i < present.length - 1; i++) {
    const from = byRoute.get(present[i])
    const to = byRoute.get(present[i + 1])
    const key = `${from.name}->${to.name}`
    if (seen.has(key)) continue
    seen.add(key)
    map.links.push({ from: from.name, to: to.name, via: from.entry || to.entry })
  }
  // Assemble walks from screens[0] — pin the spine head so Main journey is the product path.
  if (present.length) {
    const homeRoute = present[0]
    map.screens.sort((a, b) => {
      if (a.route === homeRoute) return -1
      if (b.route === homeRoute) return 1
      return entryRankPath(a.route) - entryRankPath(b.route) || a.route.localeCompare(b.route)
    })
  }
  return present
}
import { readPackage, readProject, resolveWebApp } from './readProject.js'
import { scoreFlows } from './score/score.js'

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
  const resolved = resolveWebApp(folder)
  const ghostAdmin = fs.existsSync(path.join(folder, 'apps', 'admin')) && fs.existsSync(path.join(folder, 'ghost'))
  const appPath = ghostAdmin ? path.join(folder, 'apps', 'admin') : resolved.appPath
  const pkg = ghostAdmin ? readPackage(appPath) : resolved.pkg
  const nested = ghostAdmin || resolved.nested
  const relative = ghostAdmin ? 'apps/admin' : resolved.relative
  const files = readProject(appPath)
  const planeWeb = /\/apps\/web$/.test(appPath) || relative === 'apps/web'
  const framework = ghostAdmin
    ? { id: 'vite', name: 'Ghost Admin', url: 'http://localhost:2368/ghost' }
    : planeWeb
      ? { id: 'react-router', name: 'Plane', url: process.env.FLOWMAP_PLANE_URL || 'http://127.0.0.1:3010' }
      : detectFramework(pkg, files)
  const analytics = detectAnalytics(files, folder)
  const map = mapProject(files, framework.id)
  let flows
  // Demo-friendly fill for Plane's workspace-scoped routes when a seeded slug is known.
  if (framework.id === 'react-router' || planeWeb) {
    const demoSlug = process.env.FLOWMAP_PLANE_SLUG || 'flowmap-demo'
    const projectId = process.env.FLOWMAP_PLANE_PROJECT_ID || ''
    for (const screen of map.screens) {
      let route = screen.route
      route = route.replace(/\[workspaceslug\]|:workspaceslug/gi, demoSlug)
      if (projectId) route = route.replace(/\[projectid\]|:projectid/gi, projectId)
      if (route !== screen.route) {
        screen.route = route
        screen.pattern = routePattern(route)
        screen.name = screenLabel(route)
      }
    }
    // Prefer product surfaces over settings when assembling journeys.
    // Drop auth shells and redirects so assemble starts at the workspace.
    map.screens = map.screens.filter(
      (screen) =>
        screen.route !== '/' &&
        !/^\/(login|sign-in|signin|sign-up|register|onboarding|create-workspace|invitations|workspace-invitations|accounts)(\/|$)/.test(
          screen.route,
        ) &&
        !/\/redirects\//.test(screen.entry || ''),
    )
    map.screens.sort((a, b) => entryRankPath(a.route) - entryRankPath(b.route) || a.route.localeCompare(b.route))
    // Plane's SPA nav is data-driven; seed a readable product path when links are sparse.
    const spine = seedPlaneLinks(map, demoSlug, projectId)
    if (spine.length >= 3) {
      const byRoute = new Map(map.screens.map((screen) => [screen.route, screen]))
      const byName = new Map(map.screens.map((screen) => [screen.name, screen]))
      map.links = []
      for (let i = 0; i < spine.length - 1; i++) {
        const from = byRoute.get(spine[i])
        const to = byRoute.get(spine[i + 1])
        if (from && to) map.links.push({ from: from.name, to: to.name, via: from.entry || to.entry })
      }
      // assemble() treats the workspace slug as one section and floods siblings — build Main from the spine.
      const happy = spine.map((route) => byRoute.get(route)).filter(Boolean)
      const main = buildFlow('main', 'Main journey', happy, map, byName)
      const used = new Set(happy.map((screen) => screen.name))
      const leftovers = map.screens.filter((screen) => !used.has(screen.name)).slice(0, 10)
      flows = [main]
      if (leftovers.length) flows.push(buildFlow('other', 'Other screens', leftovers, map, byName))
    }
  }
  if (!flows) flows = assemble(map)
  attachChanges(folder, flows)
  const scores = scoreFlows(flows, map)
  const { events, ...publicAnalytics } = analytics
  const name = nested ? path.basename(folder) : projectName(folder, pkg)
  return {
    project: {
      path: folder,
      appPath,
      appFolder: nested ? relative : undefined,
      name,
      framework: framework.name,
      frameworkId: framework.id,
      guessedUrl: framework.url,
      analytics: publicAnalytics,
    },
    map,
    flows,
    scores,
    events,
    stats: { files: Object.keys(files).length, screens: map.screens.length, links: map.links.length },
  }
}

function captureTargetsFor(steps) {
  return steps
    .filter((step) => {
      if (!step.route) return false
      // Mode-only states need data fixtures — still mapped, not photographed blindly.
      if (step.kind === 'overlay' && step.uiState && step.uiState.openable === false) return false
      return true
    })
    .map((step) => ({
      route: step.route,
      key: shotKeyFor(step),
      formStage: step.formStage,
      formStages: step.formStages,
      uiState: step.uiState,
      triggerError: step.kind === 'unhappy',
      errorPhrase: step.state || step.name,
      access: step.access,
    }))
}

/**
 * Screenshot every route in the flows and attach each image to its step.
 * `onShot(step, buffer)` stores the image and returns the id the step should point at.
 */
function applyShots(flows, taken, onShot) {
  for (const flow of flows) {
    for (const step of flow.steps) {
      const original = step.route
      const key = shotKeyFor(step)
      const concrete = taken.resolved?.[key] || taken.resolved?.[original]
      const shot = taken.images?.[key] || taken.images?.[original]
      if (concrete && !concrete.fallback && concrete.path !== original) {
        step.route = concrete.path
        step.resolvedFrom = original
      }
      if (Buffer.isBuffer(shot)) {
        step.shotId = onShot ? onShot(step, shot) : undefined
        step.shotW = shot.readUInt32BE(16)
        step.shotH = shot.readUInt32BE(20)
        step.shotError = undefined
        const anchorKey = concrete && !concrete.fallback ? concrete.path : original
        step.linkAnchors = taken.linkAnchors?.[key] || taken.linkAnchors?.[original] || taken.linkAnchors?.[anchorKey] || []
      } else if (shot && shot.error) {
        step.shotError = shot.error
        step.linkAnchors = []
      }
    }
    dropUnvisited(flow)
  }
}

export async function captureFlows(project, flows, { url, viewport, cookies, email, password, onShot } = {}) {
  // Never fall back to guessedUrl (:3000 etc.) — that steals whatever else is already there.
  const handle = await ensureServer(project.appPath || project.path, { id: project.frameworkId }, url)
  const credentials = { email, password }
  let auth = cookies?.length ? cookies : null
  if (!auth?.length) auth = await localGhostCookies(handle.url, credentials)
  if (!auth?.length) auth = await localFamilytreeCookies(handle.url, credentials)

  const allTargets = captureTargetsFor(flows.flatMap((f) => f.steps))
  const publicTargets = allTargets.filter((t) => t.access !== 'signed-in')
  const signedInTargets = allTargets.filter((t) => t.access === 'signed-in')

  // Public first without a session — otherwise `/` often redirects into the app and looks like “home”.
  const publicTaken = publicTargets.length
    ? await captureRoutes(handle.url, publicTargets, { viewport })
    : { images: {}, resolved: {}, linkAnchors: {} }
  applyShots(flows, publicTaken, onShot)

  let signedTaken = { images: {}, resolved: {}, linkAnchors: {} }
  if (signedInTargets.length) {
    signedTaken = await captureRoutes(handle.url, signedInTargets, {
      viewport,
      cookies: auth || undefined,
      email,
      password,
    })
    applyShots(flows, signedTaken, onShot)
  }

  return {
    liveUrl: handle.url,
    handle,
    images: { ...publicTaken.images, ...signedTaken.images },
    resolved: { ...publicTaken.resolved, ...signedTaken.resolved },
  }
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
