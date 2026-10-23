/**
 * Portable flow mapping: find pages, trace links and error/empty evidence,
 * then lay that out as lanes. No editor, no collab, no in-browser compile.
 */

const EXT = ['', '.tsx', '.ts', '.jsx', '.js', '.vue', '.svelte', '.astro', '.html', '/index.tsx', '/index.ts', '/index.jsx', '/index.js', '/index.html']
const ROUTE_DIRS = new Set(['src', 'public', 'app', 'pages', 'views', 'routes', 'static', 'www'])

const dirname = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

function joinPath(...parts) {
  const out = []
  for (const seg of parts.join('/').split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

function resolveImport(from, spec, files) {
  let bases
  if (spec.startsWith('.')) bases = [joinPath(dirname(from), spec)]
  else if (spec.startsWith('@/') || spec.startsWith('~/')) bases = [joinPath('src', spec.slice(2)), spec.slice(2)]
  else if (spec.startsWith('/')) bases = [spec.replace(/^\/+/, '')]
  else return null
  for (const base of bases) {
    for (const ext of EXT) {
      if (files[base + ext] !== undefined) return base + ext
    }
  }
  return null
}

export function routeOf(entry) {
  const parts = entry.replace(/\.(html?|[jt]sx?|vue|svelte|astro)$/i, '').split('/')
  while (parts.length > 1 && ROUTE_DIRS.has(parts[0].toLowerCase())) parts.shift()
  if (parts.length === 1 && ROUTE_DIRS.has(parts[0].toLowerCase())) parts.shift()
  const last = parts.at(-1)?.toLowerCase()
  if (last === 'page' || last === 'index' || last === 'app') parts.pop()
  const route = '/' + parts.filter((p) => !/^\(.*\)$/.test(p)).join('/')
  return (route === '/' ? '/' : route.replace(/\/+$/, '')).toLowerCase()
}

/** `/prints/[id]` and `/prints/:id` match a real product address in analytics. */
export function routePattern(route) {
  if (!route || route === '/') return '/'
  const parts = String(route)
    .split('/')
    .map((seg) => (/^\[.+\]$/.test(seg) || seg === '*' || seg.startsWith(':') ? '*' : seg))
  return parts.join('/') || '/'
}

export function normalizeRoute(target) {
  const t = target.trim()
  if (!t || /^(https?:|mailto:|tel:|javascript:|#)/i.test(t)) return null
  const pathOnly = t.split(/[?#]/)[0].replace(/^\.\//, '/')
  const clean = ('/' + pathOnly.replace(/^\/+/, '')).replace(/\/index(\.html?)?$/i, '/').replace(/\.html?$/i, '').replace(/\/+$/, '')
  return (clean || '/').toLowerCase()
}

function screenLabel(routeOrPath) {
  const cleaned = String(routeOrPath)
    .replace(/\\/g, '/')
    .replace(/\.(t|j)sx?$|\.vue$|\.html$/i, '')
    .split('/')
    .filter((s) => s && !['src', 'app', 'pages', 'views', 'page', 'index'].includes(s))
    .map((s) => s.replace(/^\[(.+)\]$/, '$1').replace(/[-_]/g, ' '))
  if (!cleaned.length) return 'Home'
  return cleaned.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(' · ')
}

function entryRank(p) {
  if (/(^|\/)(src\/)?app\/page\.(t|j)sx$/.test(p) || /(^|\/)(src\/)?pages\/index\.(t|j)sx$/.test(p) || /(^|\/)index\.html$/.test(p)) return 0
  if (/(^|\/)App\.(t|j)sx?$/.test(p)) return 0
  if (/\/(login|signup|sign-up|onboarding|dashboard|home|cart|checkout|create|prints|settings|account)(\/|$)/.test(p)) return 1
  if (/\/(about|faq|privacy|terms|returns)/.test(p)) return 6
  return 3
}

export function detectFramework(pkg, files) {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  if (deps.next) return { id: 'next', name: 'Next.js', url: 'http://127.0.0.1:3000' }
  if (deps.nuxt) return { id: 'nuxt', name: 'Nuxt', url: 'http://127.0.0.1:3000' }
  if (deps.vite || deps['@sveltejs/kit']) return { id: 'vite', name: deps['@sveltejs/kit'] ? 'SvelteKit' : 'Vite', url: 'http://127.0.0.1:5173' }
  if (deps.vue) return { id: 'vue', name: 'Vue', url: 'http://127.0.0.1:5173' }
  if (Object.keys(files).some((p) => p.endsWith('.html'))) return { id: 'html', name: 'HTML', url: 'http://127.0.0.1:5173' }
  return { id: 'unknown', name: 'Unknown', url: 'http://127.0.0.1:3000' }
}

function pageEntries(files, frameworkId) {
  const paths = Object.keys(files)
  const patterns =
    frameworkId === 'next'
      ? [/^(src\/)?app\/(?:.+\/)?page\.(t|j)sx$/, /^(src\/)?pages\/(?!api\/).+\.(t|j)sx$/]
      : frameworkId === 'vue'
        ? [/^src\/App\.vue$/, /^(src\/)?(views|pages)\/.+\.vue$/]
        : frameworkId === 'html'
          ? [/^index\.html$/, /\.html$/]
          : [/^src\/App\.(t|j)sx?$/, /^App\.(t|j)sx?$/]
  const matched = []
  for (const re of patterns) {
    for (const p of paths) if (re.test(p) && !matched.includes(p)) matched.push(p)
  }
  return matched.sort((a, b) => entryRank(a) - entryRank(b) || a.localeCompare(b))
}

function componentFile(from, code, tag, files) {
  const named = new RegExp(`import\\s+\\{[^}]*\\b${tag}\\b[^}]*\\}\\s+from\\s+["']([^"']+)["']`)
  const def = new RegExp(`import\\s+${tag}\\s+from\\s+["']([^"']+)["']`)
  const spec = code.match(named)?.[1] || code.match(def)?.[1]
  return spec ? resolveImport(from, spec, files) : null
}

/** Scroll and forms are interactions, not another page. */
function gesturesFor(code) {
  const names = []
  if (/whileInView|\bIntersectionObserver\b|\bonScroll\b|\buseScroll\b|scrollIntoView/.test(code)) names.push('Scroll')
  if (/<form\b/.test(code)) names.push('Form')
  return names
}

/** `export const RESEARCH_PATH = '/research/…'` so a route can name its address. */
function pathConstants(files) {
  const constants = new Map()
  for (const code of Object.values(files)) {
    for (const match of code.matchAll(/(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*['"](\/[^'"]*)['"]/g)) {
      constants.set(match[1], match[2])
    }
  }
  return constants
}

function readJsValue(code, index) {
  const quote = code[index]
  if (quote === '"' || quote === "'" || quote === '`') {
    let i = index + 1
    while (i < code.length) {
      if (code[i] === '\\') {
        i += 2
        continue
      }
      if (quote === '`' && code[i] === '$' && code[i + 1] === '{') {
        let depth = 1
        i += 2
        while (i < code.length && depth) {
          if (code[i] === '{') depth += 1
          else if (code[i] === '}') depth -= 1
          i += 1
        }
        continue
      }
      if (code[i] === quote) return code.slice(index, i + 1)
      i += 1
    }
    return null
  }
  if (quote === '{') {
    let depth = 0
    for (let i = index; i < code.length; i += 1) {
      if (code[i] === '{') depth += 1
      else if (code[i] === '}') {
        depth -= 1
        if (depth === 0) return code.slice(index + 1, i)
      }
    }
  }
  return null
}

function resolvePathExpr(expr, constants) {
  const trimmed = String(expr || '').trim()
  if (!trimmed) return null
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('`') && trimmed.endsWith('`'))) {
    const inner = trimmed.slice(1, -1).replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_, name) => constants.get(name) || '')
    if (inner.includes('${')) return null
    return inner
  }
  if (/^[A-Z][A-Z0-9_]*$/.test(trimmed)) return constants.get(trimmed) || null
  return null
}

/** `/writing/:slug` becomes each essay the project actually names. */
function concretePaths(route, files) {
  const parts = String(route).split('/')
  const dynamic = parts.map((part, index) => (part.startsWith(':') ? index : -1)).filter((index) => index >= 0)
  if (dynamic.length !== 1 || dynamic[0] !== parts.length - 1) return []
  const prefix = parts.slice(0, -1).join('/')
  if (!prefix || prefix === '/') return []
  const found = new Set()
  const literal = new RegExp(`['"\`](${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[A-Za-z0-9][A-Za-z0-9-]*)/?['"\`]`, 'g')
  const slug = /(?:\bslug\s*[:=]\s*|\b[A-Za-z]*[Ss]lug\(\s*)['"]([A-Za-z0-9][A-Za-z0-9-]*)['"]/g
  for (const code of Object.values(files)) {
    for (const match of code.matchAll(literal)) found.add(match[1].replace(/\/+$/, ''))
    if (!code.includes(prefix)) continue
    for (const match of code.matchAll(slug)) found.add(`${prefix}/${match[1]}`)
  }
  return [...found].sort().slice(0, 12)
}

/** `<Route path={RESEARCH_PATH}>` and `<Route path="/pricing">` are both addresses. */
function routerScreens(files, constants) {
  const found = []
  const seen = new Set()
  const add = (route, pattern, entry) => {
    const clean = normalizeRoute(route)
    if (!clean || seen.has(clean)) return
    seen.add(clean)
    found.push({ name: screenLabel(clean), entry, route: clean, pattern: pattern || routePattern(clean) })
  }
  for (const [file, code] of Object.entries(files)) {
    for (const match of code.matchAll(/<Route\b/g)) {
      const window = code.slice(match.index, match.index + 1200)
      const pathAt = window.search(/\bpath\s*=/)
      if (pathAt < 0) continue
      const equals = window.slice(pathAt).match(/\bpath\s*=\s*/)
      const expr = readJsValue(code, match.index + pathAt + equals[0].length)
      const raw = resolvePathExpr(expr, constants)
      if (!raw || raw === '*') continue
      const tag = window.match(/\belement\s*=\s*\{?\s*<(\w+)/)?.[1]
      if (tag === 'Navigate') continue
      const entry = (tag && componentFile(file, code, tag, files)) || file
      const owner = files[entry] || ''
      const start = tag ? owner.search(new RegExp(`function ${tag}\\b`)) : -1
      if (start >= 0) {
        const returns = [...owner.slice(start, start + 1800).matchAll(/return\s*\(?\s*<(\w+)/g)].map((item) => item[1])
        if (returns.length && returns.every((name) => name === 'Navigate')) continue
      }
      const pattern = normalizeRoute(raw.replace(/:[\w.]+/g, '*')) || routePattern(raw)
      if (/:[\w.]/.test(raw)) {
        const pages = concretePaths(raw, files)
        if (pages.length) {
          for (const page of pages) add(page, pattern, entry)
          continue
        }
      }
      add(raw.replace(/:[\w.]+/g, 'demo'), pattern, entry)
    }
  }
  return found.length >= 2 ? found : []
}

const LINK_PATTERNS = [
  /\bhref\s*=\s*\{?\s*["'`]([^"'`]+)["'`]/g,
  /\bto\s*=\s*\{?\s*["'`](\/[^"'`]*)["'`]/g,
  /\blocation(?:\.href)?\s*=\s*["'`]([^"'`]+)["'`]/g,
  /\b(?:router|history)\.(?:push|replace)\(\s*["'`]([^"'`]+)["'`]/g,
  /\b(?:navigate|redirect)\(\s*["'`]([^"'`]+)["'`]/g,
]

/** User-visible copy, not catch blocks, console logs, or a colour named "error". */
const VISIBLE_STATE = [
  /alert\(\s*[`'"]([^`'"]{6,90})[`'"]/,
  /set[A-Z]\w*Error\(\s*[`'"]([^`'"]{6,90})[`'"]/,
  />\s*([^<]{0,90}(?:empty|not found|no [\w ]+|failed|try again|went wrong|unavailable)[^<]{0,40})\s*</i,
  /title:\s*[`'"]([^`'"]{4,80}(?:not found|empty|failed|unavailable)[^`'"]{0,40})[`'"]/i,
]

function screenFiles(entry, files) {
  const seen = new Set()
  const visit = (file, depth) => {
    if (seen.has(file) || files[file] === undefined) return
    seen.add(file)
    if (depth >= 3) return
    const code = files[file]
    const specs = []
    for (const m of code.matchAll(/\bimport\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
      specs.push(m[1] ?? m[2])
    }
    for (const spec of specs) {
      if (/^https?:/.test(spec) || /\.(css|scss|json|svg)$/i.test(spec)) continue
      const hit = resolveImport(file, spec, files)
      if (hit) visit(hit, depth + 1)
    }
  }
  visit(entry, 0)
  return [...seen]
}

/** Imports written in the screen file itself, not the whole tree. */
function directImports(entry, files) {
  const code = files[entry]
  if (!code) return []
  const out = []
  for (const m of code.matchAll(/\bimport\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g)) {
    const hit = resolveImport(entry, m[1], files)
    if (hit && !/\.(css|scss|json|svg)$/i.test(hit)) out.push(hit)
  }
  return out
}

function routeSegments(route) {
  return String(route)
    .split('?')[0]
    .split('/')
    .filter(Boolean)
    .map((part) => (/^\[.+\]$/.test(part) || part === '*' || part.startsWith(':') ? '*' : part.toLowerCase()))
}

/** Match `/prints/${id}` and `/prints/q/${slug}` onto dynamic page files. */
function screenForTarget(raw, screens) {
  if (!raw) return null
  const pathOnly = raw.split('?')[0].trim().replace(/\$\{[^}]+\}/g, '*')
  if (!pathOnly.startsWith('/') || pathOnly.includes('${')) return null
  const exact = normalizeRoute(pathOnly.replace(/\*/g, ''))
  if (exact && !pathOnly.includes('*')) {
    const hit = screens.find((s) => s.route === exact)
    if (hit) return hit
  }
  const wanted = routeSegments(pathOnly)
  return (
    screens.find((s) => {
      const got = routeSegments(s.route)
      return got.length === wanted.length && got.every((part, i) => part === wanted[i] || part === '*' || wanted[i] === '*')
    }) ?? null
  )
}

function routesReturnedBy(name, files) {
  const re = new RegExp(`function ${name}\\b[\\s\\S]{0,700}`)
  for (const code of Object.values(files)) {
    const found = code.match(re)
    if (!found) continue
    const routes = []
    for (const m of found[0].matchAll(/[`'"](\/[^`'"]+)[`'"]/g)) {
      routes.push(m[1].replace(/\$\{[^}]+\}/g, '*').split('?')[0])
    }
    return routes
  }
  return []
}

function targetsOnLine(line, files, screens, constants) {
  const found = []
  const push = (raw, literal) => {
    const screen = screenForTarget(raw, screens)
    if (screen) found.push({ screen, literal })
  }
  for (const re of LINK_PATTERNS) {
    for (const m of line.matchAll(re)) push(m[1], true)
  }
  for (const m of line.matchAll(/\b(?:to|href)\s*=\s*\{([A-Z][A-Z0-9_]*)\}/g)) {
    const route = constants.get(m[1])
    if (route) push(route, true)
  }
  for (const m of line.matchAll(/\bto\s*:\s*['"](\/[^'"]+)['"]/g)) push(m[1], true)
  for (const m of line.matchAll(/\bto\s*:\s*([A-Z][A-Z0-9_]*)\b/g)) {
    const route = constants.get(m[1])
    if (route) push(route, true)
  }
  for (const m of line.matchAll(/\bhref\s*=\s*\{([A-Za-z_][\w]*)\s*\(/g)) {
    for (const route of routesReturnedBy(m[1], files)) push(route, true)
  }
  return found
}

function visiblePhrase(line) {
  const trimmed = line.trim()
  if (/console\.|catch\s*\(|^\s*\/\/|\bgtag\s*\(|posthog\.|plausible\s*\(/.test(trimmed)) return null
  for (const re of VISIBLE_STATE) {
    const match = trimmed.match(re)
    const phrase = match?.[1]?.replace(/\s+/g, ' ').trim()
    if (phrase && phrase.length >= 6 && phrase.length <= 90 && !phrase.includes('${')) return phrase
  }
  return null
}

export function mapProject(files, frameworkId) {
  const constants = pathConstants(files)
  const routed = frameworkId === 'next' ? [] : routerScreens(files, constants)
  let screens = routed.length
    ? routed.slice(0, 32)
    : pageEntries(files, frameworkId)
        .filter((p) => entryRank(p) <= 6)
        .slice(0, 32)
        .map((entry) => {
          const route = routeOf(entry)
          return { name: screenLabel(entry), entry, route, pattern: routePattern(route) }
        })

  const seenRoutes = new Set()
  screens = screens.filter((s) => {
    if (seenRoutes.has(s.route)) return false
    seenRoutes.add(s.route)
    return true
  })

  const mapped = screens.map((s) => {
    const direct = directImports(s.entry, files)
    const owned = [s.entry, ...direct].filter((file) => files[file] !== undefined)
    return { ...s, files: screenFiles(s.entry, files), direct, gestures: gesturesFor(owned.map((file) => files[file]).join('\n')) }
  })
  const byRoute = new Map(mapped.map((s) => [s.route, s]))
  const home = mapped.find((s) => s.route === '/') ?? mapped[0]

  const links = []
  const seenLinks = new Set()
  const evidence = []

  const addLink = (owner, target, context, conditional) => {
    if (!owner || !target || owner.name === target.name) return
    const key = `${owner.name}>${target.name}`
    if (seenLinks.has(key)) return
    seenLinks.add(key)
    links.push({ from: owner.name, to: target.name, context, conditional })
  }

  for (const screen of mapped) {
    const ownedFiles = new Set([screen.entry, ...screen.direct])
    for (const file of ownedFiles) {
      if (files[file] === undefined) continue
      // Nav/footer chrome is global. Count it from the home screen only.
      const sharedChrome = /(?:^|\/)(layout|navbar|footer|site-?chrome|header)\.(t|j)sx?$/i.test(file)
      if (sharedChrome && screen !== home) continue
      const lines = files[file].split('\n')
      let fileEvidence = 0
      lines.forEach((line, i) => {
        const targets = targetsOnLine(line, files, mapped, constants)
        const context = lines.slice(Math.max(0, i - 1), i + 1).map((l) => l.trim()).filter(Boolean).join(' · ').slice(0, 220)
        const conditional = /\b(if|catch)\b/.test(line) && !targets.some((t) => t.literal)
        for (const target of targets) addLink(screen, target.screen, context, conditional && !target.literal)
        if (file === screen.entry || screen.direct.includes(file)) {
          const phrase = visiblePhrase(line)
          if (phrase && fileEvidence < 3) {
            evidence.push({ file, line: i + 1, screens: [screen.name], phrase, snippet: phrase })
            fileEvidence++
          }
        }
      })
    }
  }

  // Buy / add-to-cart often sits one import deeper than the page. Count only those
  // links when they continue into cart, checkout, or order success.
  for (const screen of mapped) {
    for (const file of screen.files) {
      if (!files[file] || file === screen.entry || screen.direct.includes(file)) continue
      for (const line of files[file].split('\n')) {
        for (const target of targetsOnLine(line, files, mapped, constants)) {
          const section = target.screen.route.split('/').filter(Boolean)[0]?.toLowerCase()
          if (!CONTINUATIONS.has(section)) continue
          addLink(screen, target.screen, `Continues to ${target.screen.name}`, false)
        }
      }
    }
  }

  // Layout and nav are not imported by each page. Their links start from home.
  if (home) {
    for (const [file, code] of Object.entries(files)) {
      if (!/(?:^|\/)(layout|navbar|footer|site-?chrome)\.(t|j)sx?$/i.test(file)) continue
      for (const line of code.split('\n')) {
        for (const target of targetsOnLine(line, files, mapped, constants)) addLink(home, target.screen, 'Site navigation', false)
      }
    }
  }

  return { screens: mapped.map(({ files: _f, direct: _d, ...s }) => s), links, evidence: evidence.slice(0, 40) }
}

function stateKind(phrase) {
  if (/empty|no [\w ]+ available|nothing here/i.test(phrase)) return 'empty'
  if (/not found/i.test(phrase)) return 'missing'
  if (/sign in|log in|unauthori/i.test(phrase)) return 'auth'
  return 'error'
}

function nid(prefix, n) {
  return `${prefix}${n}`
}

function walkFrom(start, byName, map, blocked, limit) {
  const order = []
  const seen = new Set()
  const queue = [start]
  while (queue.length && order.length < limit) {
    const screen = queue.shift()
    if (!screen || seen.has(screen.name)) continue
    seen.add(screen.name)
    order.push(screen)
    for (const link of map.links) {
      if (link.from !== screen.name || link.conditional) continue
      if (blocked.has(link.to)) continue
      const next = byName.get(link.to)
      if (next) queue.push(next)
    }
  }
  return order
}

function buildFlow(id, name, happy, map, byName) {
  const lanes = []
  const steps = []
  const edges = []
  let n = 0
  const happyLane = { id: `${id}-happy`, name: 'Happy path', kind: 'happy' }
  lanes.push(happyLane)
  const stepByScreen = new Map()
  let prev = null
  happy.forEach((screen, col) => {
    const step = {
      id: nid('step', ++n),
      laneId: happyLane.id,
      name: screen.name,
      route: screen.route,
      pattern: screen.pattern || routePattern(screen.route),
      entry: screen.entry,
      col,
      note: screen.route,
      gestures: screen.gestures || [],
      kind: 'happy',
    }
    steps.push(step)
    stepByScreen.set(screen.name, step)
    if (prev) edges.push({ id: nid('edge', ++n), from: prev.id, to: step.id })
    prev = step
  })

  for (const link of map.links.filter((l) => l.conditional && stepByScreen.has(l.from)).slice(0, 3)) {
    const target = byName.get(link.to)
    if (!target) continue
    const from = stepByScreen.get(link.from)
    const lane = { id: nid('lane', ++n), name: `Branch to ${link.to}`, kind: 'edge' }
    lanes.push(lane)
    const step = {
      id: nid('step', ++n),
      laneId: lane.id,
      name: link.to,
      route: target.route,
      pattern: target.pattern || routePattern(target.route),
      entry: target.entry,
      col: from.col + 1,
      note: link.context.slice(0, 160),
      kind: 'edge',
    }
    steps.push(step)
    edges.push({ id: nid('edge', ++n), from: from.id, to: step.id, label: 'if' })
  }

  const groups = new Map()
  const entryStep = happy[0]
  for (const item of map.evidence) {
    const screen = item.screens.find((screenName) => {
      if (!stepByScreen.has(screenName) || !item.phrase) return false
      // Shared chrome imported by the first screen (usually home) would otherwise
      // stamp the same state onto every journey.
      if (entryStep && screenName === entryStep.name && item.file !== entryStep.entry) return false
      return true
    })
    if (!screen) continue
    const key = item.phrase.toLowerCase()
    if (!groups.has(key)) groups.set(key, { screen, phrase: item.phrase, evidence: item, kind: stateKind(item.phrase) })
  }
  let unhappy = 0
  let stateLane = null
  const stateCols = new Set()
  for (const group of groups.values()) {
    if (unhappy++ >= 4) break
    const from = stepByScreen.get(group.screen)
    if (!stateLane) {
      stateLane = { id: nid('lane', ++n), name: 'When it goes wrong', kind: 'unhappy' }
      lanes.push(stateLane)
    }
    let col = from.col
    while (stateCols.has(col)) col += 1
    stateCols.add(col)
    const step = {
      id: nid('step', ++n),
      laneId: stateLane.id,
      name: group.phrase,
      route: from.route,
      pattern: from.pattern || routePattern(from.route),
      entry: from.entry,
      col,
      note: group.phrase,
      evidence: `${group.evidence.file}:${group.evidence.line}`,
      kind: 'unhappy',
      state: group.phrase,
    }
    steps.push(step)
    edges.push({ id: nid('edge', ++n), from: from.id, to: step.id })
  }

  return { id, name, lanes, steps, edges }
}

const CONTINUATIONS = new Set(['cart', 'checkout', 'order-success', 'login', 'signup', 'sign-in'])

function sectionOf(route) {
  return route.split('/').filter(Boolean)[0]?.toLowerCase() || ''
}

function titleCase(value) {
  return value.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * One journey per area of the site (prints, create, admin…), following links
 * including dynamic routes, then cart and checkout when that area leads there.
 */
export function assemble(map) {
  const screens = map.screens
  if (!screens.length) return []
  const byName = new Map(screens.map((s) => [s.name, s]))
  const home = screens.find((s) => s.route === '/') ?? screens[0]
  const hops = []
  const seenHop = new Set()
  for (const link of map.links) {
    if (link.from !== home.name || link.conditional || link.to === home.name || seenHop.has(link.to)) continue
    const dest = byName.get(link.to)
    if (!dest || CONTINUATIONS.has(sectionOf(dest.route))) continue
    seenHop.add(link.to)
    hops.push(dest)
  }

  const groups = new Map()
  for (const hop of hops) {
    const key = sectionOf(hop.route) || hop.name
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(hop)
  }

  const flows = []
  const used = new Set()
  const outgoing = (name) => map.links.filter((l) => l.from === name && !l.conditional)

  for (const [key, group] of groups) {
    const allowed = new Set(
      screens.filter((s) => sectionOf(s.route) === key || CONTINUATIONS.has(sectionOf(s.route)) || s.name === home.name).map((s) => s.name),
    )
    const path = [home]
    const seen = new Set([home.name])
    const siblings = screens.filter((s) => sectionOf(s.route) === key && !group.includes(s))
    const queue = [...group, ...siblings]
    while (queue.length && path.length < 10) {
      const screen = queue.shift()
      if (!screen || seen.has(screen.name) || !allowed.has(screen.name)) continue
      seen.add(screen.name)
      path.push(screen)
      for (const link of outgoing(screen.name)) {
        const next = byName.get(link.to)
        if (next && allowed.has(next.name)) queue.push(next)
      }
    }
    const body = path.filter((s) => s === home || !CONTINUATIONS.has(sectionOf(s.route)))
    const tail = [...CONTINUATIONS].map((seg) => path.find((s) => sectionOf(s.route) === seg)).filter(Boolean)
    const ordered = [...body, ...tail.filter((s) => !body.includes(s))]
    flows.push(buildFlow(`flow-${flows.length + 1}`, titleCase(key), ordered, map, byName))
    ordered.forEach((s) => used.add(s.name))
  }

  if (!flows.length) {
    const path = walkFrom(home, byName, map, new Set(), 8)
    flows.push(buildFlow('main', 'Main journey', path, map, byName))
    path.forEach((s) => used.add(s.name))
  }

  const leftovers = screens.filter((s) => !used.has(s.name)).slice(0, 10)
  if (leftovers.length) flows.push(buildFlow('other', 'Other screens', leftovers, map, byName))
  return flows.filter((flow) => flow.steps.length)
}
