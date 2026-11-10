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
  // Drop package prefixes (frontend/, apps/web/, …) until we hit a router root.
  while (parts.length > 1 && !ROUTE_DIRS.has(parts[0].toLowerCase()) && parts[0].toLowerCase() !== 'page') {
    const next = parts[1]?.toLowerCase()
    if (ROUTE_DIRS.has(next) || next === 'src') parts.shift()
    else break
  }
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

export function screenLabel(routeOrPath) {
  const raw = String(routeOrPath).replace(/\\/g, '/')
  const isRoute = raw.startsWith('/')
  const cleaned = raw
    .replace(/\.(t|j)sx?$|\.vue$|\.html$/i, '')
    .split('/')
    .filter((s) => {
      if (!s) return false
      // File-path chrome only — keep product segments like /pages and /views.
      if (['src', 'app', 'page', 'index'].includes(s)) return false
      if (!isRoute && (s === 'pages' || s === 'views')) return false
      if (/^\(.*\)$/.test(s)) return false
      return true
    })
    .map((s) => s.replace(/^\[(.+)\]$/, '$1').replace(/[-_]/g, ' '))
  if (!cleaned.length) return 'Home'
  return cleaned.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(' · ')
}

function entryRank(p) {
  if (/(^|\/)(src\/)?app\/page\.(t|j)sx$/.test(p) || /(^|\/)(src\/)?pages\/index\.(t|j)sx$/.test(p) || /(^|\/)index\.html$/.test(p)) return 0
  if (/(^|\/)App\.(t|j)sx?$/.test(p)) return 0
  // Product journeys first — settings/billing tend to dominate otherwise.
  if (/\/(projects|issues|cycles|modules|pages|intake|views|active-cycles|notifications|drafts)(\/|$)/.test(p)) return 1
  if (/\/(login|signup|sign-up|onboarding|dashboard|home|cart|checkout|create|prints|account)(\/|$)/.test(p)) return 2
  if (/\/(settings|billing|webhooks|exports|integrations)(\/|$)/.test(p)) return 5
  if (/\/(about|faq|privacy|terms|returns)/.test(p)) return 6
  return 3
}

function scriptPort(pkg, fallback) {
  const scripts = Object.values(pkg?.scripts || {}).join('\n')
  const port =
    scripts.match(/(?:^|\s)(?:-p|--port)\s+(\d+)\b/m)?.[1] ||
    scripts.match(/\bPORT=(\d+)\b/)?.[1]
  return port || fallback
}

export function detectFramework(pkg, files) {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  if (deps.next) return { id: 'next', name: 'Next.js', url: `http://127.0.0.1:${scriptPort(pkg, '3000')}` }
  if (deps.nuxt) return { id: 'nuxt', name: 'Nuxt', url: `http://127.0.0.1:${scriptPort(pkg, '3000')}` }
  // React Router framework mode (Plane, etc.) — app/**/page.tsx + route("path", …)
  if (deps['@react-router/dev'] || deps['@react-router/node'] || deps['react-router']) {
    return { id: 'react-router', name: 'React Router', url: `http://127.0.0.1:${scriptPort(pkg, '3000')}` }
  }
  if (deps.vite || deps['@sveltejs/kit']) {
    return {
      id: 'vite',
      name: deps['@sveltejs/kit'] ? 'SvelteKit' : 'Vite',
      url: `http://127.0.0.1:${scriptPort(pkg, '5173')}`,
    }
  }
  if (deps.vue) return { id: 'vue', name: 'Vue', url: `http://127.0.0.1:${scriptPort(pkg, '5173')}` }
  if (Object.keys(files).some((p) => p.endsWith('.html'))) return { id: 'html', name: 'HTML', url: 'http://127.0.0.1:5173' }
  return { id: 'unknown', name: 'Unknown', url: 'http://127.0.0.1:3000' }
}

const APP_PAGE = /^(?:[\w.-]+\/)*(src\/)?app\/(?:.+\/)?page\.(t|j)sx$/
const APP_PAGES_DIR = /^(?:[\w.-]+\/)*(src\/)?pages\/(?!api\/).+\.(t|j)sx$/

function pageEntries(files, frameworkId) {
  const paths = Object.keys(files)
  const patterns =
    frameworkId === 'next' || frameworkId === 'react-router'
      ? [APP_PAGE, APP_PAGES_DIR]
      : frameworkId === 'vite'
        ? [APP_PAGE, /^(?:[\w.-]+\/)*src\/App\.(t|j)sx?$/, /^(?:[\w.-]+\/)*App\.(t|j)sx?$/]
        : frameworkId === 'vue'
          ? [/^(?:[\w.-]+\/)*src\/App\.vue$/, /^(?:[\w.-]+\/)*(src\/)?(views|pages)\/.+\.vue$/]
          : frameworkId === 'html'
            ? [/^index\.html$/, /\.html$/]
            : [APP_PAGE, /^(?:[\w.-]+\/)*src\/App\.(t|j)sx?$/, /^(?:[\w.-]+\/)*App\.(t|j)sx?$/]
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
  if (
    /<form\b|\bvalidateCurrentStage\b|\bSTAGE_LABELS\b|\bsetError\s*\(|\bcurrentStep\b|\bsteps\s*:\s*\w*Step/.test(
      code,
    )
  ) {
    names.push('Form')
  }
  if (uiStatesOf(code).length) names.push('Overlay')
  return names
}

const UI_TOGGLE_SUFFIX =
  /(Modal|Dialog|Overlay|Sheet|Drawer|Panel|Preview|Invite|Consent|Order|Print|Player|Share|Confirm|Popover|Menu)$/i
const UI_TOGGLE_SKIP = /(Error|Password|Tooltip|Spinner|Loading|Skeleton|Toast|Hover|Focus|Valid|Dirty|Touched)/i

function isUiToggleName(name) {
  if (!name || UI_TOGGLE_SKIP.test(name)) return false
  if (!/^(show|is)[A-Z]/i.test(name)) return false
  return UI_TOGGLE_SUFFIX.test(name)
}

/** Button / aria copy near `setShowX(true)` — used to open the overlay in capture. */
function triggersForSetter(code, setter) {
  if (!setter) return []
  const labels = []
  const re = new RegExp(`${setter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(\\s*true\\s*\\)`, 'g')
  for (const m of code.matchAll(re)) {
    const before = code.slice(Math.max(0, m.index - 350), m.index)
    // Only controls that open on click/press — skip cascading setState in callbacks.
    if (!/on(?:Click|Press|Select)\s*=/.test(before.slice(-120))) continue
    const after = code.slice(m.index, Math.min(code.length, m.index + 500))
    const close = after.search(/<\/[A-Za-z][\w.-]*>/)
    // Keep the closing tag so `>Label</button>` still matches.
    const window = close >= 0 ? after.slice(0, close + 16) : after.slice(0, 220)
    // Prefer visible text nodes inside the control (skip icon-only fragments).
    const texts = [...window.matchAll(/>\s*([^<>{]{1,64}?)\s*</g)]
      .map((item) => item[1].replace(/\s+/g, ' ').trim())
      .filter((text) => text && /^[A-Za-z]/.test(text) && text.length >= 3)
    if (texts.length) {
      labels.push(texts.sort((a, b) => b.length - a.length)[0])
      continue
    }
    const aria = [...before.matchAll(/aria-label\s*=\s*['"`]([^'"`]{2,60})['"`]/g)].map((item) => item[1].trim())
    if (aria.length) labels.push(aria[aria.length - 1])
  }
  return [...new Set(labels)].slice(0, 4)
}

/**
 * Same-URL overlays / dialogs / sheets discovered from common React patterns.
 * Generalised: show*Modal toggles, Dialog open={…}, and page-mode enums.
 */
export function uiStatesOf(code) {
  if (!code) return []
  const out = []
  const seen = new Set()
  const push = (state) => {
    const id = String(state.id || '')
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40)
    if (!id || seen.has(id.toLowerCase())) return
    seen.add(id.toLowerCase())
    out.push({
      id,
      label: state.label || titleFromId(id),
      kind: state.kind || 'overlay',
      triggers: state.triggers || [],
      openable: Boolean(state.openable ?? state.triggers?.length),
    })
  }

  for (const m of code.matchAll(/\[\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s*\]\s*=\s*useState\s*\(\s*(?:false|true)?\s*\)/g)) {
    const flag = m[1]
    const setter = m[2]
    if (!isUiToggleName(flag)) continue
    const triggers = triggersForSetter(code, setter)
    const used =
      triggers.length > 0 ||
      new RegExp(`\\{${flag}\\s*&&`).test(code) ||
      new RegExp(`\\b(?:open|isOpen)=\\{\\s*${flag}\\s*\\}`).test(code) ||
      new RegExp(`${flag}\\s*\\?`).test(code) ||
      /<(?:[A-Za-z]*)(?:Dialog|Modal|Sheet|Drawer|Overlay|Popover|AlertDialog)\b/.test(code)
    if (!used) continue
    const id = flag.replace(/^show/i, '').replace(/^is/i, '').replace(/Open$/i, '') || flag
    push({ id, label: titleFromId(id), kind: 'overlay', triggers, openable: triggers.length > 0 })
  }

  // `{isOpen && ( <div className="fixed…">` — common custom modal without a typed name.
  for (const m of code.matchAll(/\{\s*(isOpen|open)\s*&&/g)) {
    const flag = m[1]
    const setter = flag === 'open' ? 'setOpen' : 'setIsOpen'
    const triggers = triggersForSetter(code, setter)
    if (!triggers.length) continue
    push({
      id: 'dialog',
      label: triggers[0] || 'Dialog',
      kind: 'overlay',
      triggers,
      openable: true,
    })
  }

  // Controlled dialogs: <Dialog open={orderOpen} /> with setOrderOpen(true) nearby.
  for (const m of code.matchAll(/\bopen=\{\s*([A-Za-z_]\w*)\s*\}/g)) {
    const flag = m[1]
    if (seen.has(flag.toLowerCase()) || seen.has(flag.replace(/Open$/i, '').toLowerCase())) continue
    if (flag === 'open' || flag === 'isOpen') continue
    // Require a dialog-ish name — not every boolean like showInfo / hasData.
    if (!/(Modal|Dialog|Sheet|Drawer|Overlay|Open)$/i.test(flag)) continue
    const setter = `set${flag.charAt(0).toUpperCase()}${flag.slice(1)}`
    const triggers = triggersForSetter(code, setter)
    push({
      id: flag.replace(/Open$/i, '') || flag,
      label: titleFromId(flag.replace(/Open$/i, '') || flag),
      kind: 'overlay',
      triggers,
    })
  }

  // Page modes: fooState === 'celebration' (not form currentStep / wizard stages).
  for (const m of code.matchAll(/\b([A-Za-z_]\w*(?:State|Mode|View|Phase|Layout|Status))\s*===\s*['"`]([\w-]+)['"`]/g)) {
    const value = m[2]
    if (
      /^(normal|idle|closed|default|loading|error|pending|none|empty|false|true|tree|person|people|media|photo|active|inactive)$/i.test(
        value,
      )
    ) {
      continue
    }
    // Prefer human-facing product modes over internal machine values.
    if (!/[a-z]{4,}/i.test(value) && !/-/.test(value)) continue
    push({
      id: value,
      label: titleFromId(value),
      kind: 'mode',
      triggers: [],
      openable: false,
    })
  }

  return out.slice(0, 8)
}

function titleFromId(id) {
  return String(id || '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Bracket-match the first `steps = [ … ]` / `STAGES = [ … ]` body. */
function arrayBodyAfter(code, nameRe) {
  const decl = code.match(nameRe)
  if (!decl) return null
  const start = decl.index + decl[0].length
  let depth = 1
  for (let i = start; i < code.length; i++) {
    const ch = code[i]
    if (ch === '[') depth += 1
    else if (ch === ']') {
      depth -= 1
      if (depth === 0) return code.slice(start, i)
    }
  }
  return null
}

/** Client-side wizards that stay on one URL (STAGE_LABELS / STAGES / steps[]). */
export function formStagesOf(code) {
  if (!code) return []
  const labelsBlock = code.match(/\bSTAGE_LABELS\s*=\s*\{([\s\S]*?)\}/)
  if (labelsBlock) {
    const stages = []
    for (const m of labelsBlock[1].matchAll(/([A-Za-z_]\w*)\s*:\s*['"`]([^'"`]+)['"`]/g)) {
      stages.push({ id: m[1], label: m[2].trim() })
    }
    if (stages.length >= 2) return stages
  }
  const stagesBody = arrayBodyAfter(code, /\bSTAGES\s*=\s*\[/)
  if (stagesBody) {
    const ids = [...stagesBody.matchAll(/['"`]([A-Za-z_]\w*)['"`]/g)].map((m) => m[1])
    if (ids.length >= 2) return ids.map((id) => ({ id, label: titleFromId(id) }))
  }
  const stepsBody = arrayBodyAfter(code, /\b(?:const|let)\s+steps(?:\s*:\s*[^=]+)?\s*=\s*\[/)
  if (stepsBody) {
    const stages = []
    const seen = new Set()
    for (const m of stepsBody.matchAll(/\bid\s*:\s*['"`]([\w-]+)['"`]/g)) {
      const id = m[1]
      if (seen.has(id)) continue
      const from = m.index
      const next = stepsBody.slice(from + m[0].length).search(/\bid\s*:\s*['"`]/)
      const chunk = stepsBody.slice(from, next >= 0 ? from + m[0].length + next : from + 900)
      // Step objects declare a `type`; option rows usually do not.
      if (!/\btype\s*:\s*['"`]\w+['"`]/.test(chunk)) continue
      const questionBlock = chunk.match(/\bquestion\s*:([\s\S]*?)(?=\b(?:icon|type|subtext|field|options|skipable)\s*:)/)?.[1] || ''
      const plainQuestions = [
        ...[...questionBlock.matchAll(/"([^"]{3,90})"/g)].map((item) => item[1].trim()),
        ...[...questionBlock.matchAll(/'([^']{3,90})'/g)].map((item) => item[1].trim()),
      ].filter(Boolean)
      // Longest plain string wins (avoids matching apostrophe fragments inside copy).
      const question = plainQuestions.sort((a, b) => b.length - a.length)[0]
      seen.add(id)
      stages.push({ id, label: question || titleFromId(id) })
    }
    if (stages.length >= 2) return stages
    // `const steps: FormStep[] = ['name', 'gender', …]` — string list wizards.
    if (/\bcurrentStep\b/.test(code)) {
      const ids = [...stepsBody.matchAll(/['"`]([\w-]+)['"`]/g)].map((m) => m[1])
      if (ids.length >= 2) return ids.map((id) => ({ id, label: titleFromId(id) }))
    }
  }
  return []
}

/** Which wizard stage owns a setError / validation phrase. */
export function stageIdForPhrase(code, phrase) {
  if (!code || !phrase) return null
  const needle = phrase.slice(0, 40)
  const blocks = code.split(/currentStage\s*===\s*['"`]/)
  for (let i = 1; i < blocks.length; i++) {
    const id = blocks[i].match(/^(\w+)['"`]/)?.[1]
    if (!id) continue
    if (blocks[i].includes(needle)) return id
  }
  return null
}

/** Stable key so one URL can hold several form-stage / overlay / error shots. */
export function shotKeyFor(step) {
  const route = step?.route || '/'
  if (step?.formStage?.id) return `${route}::stage:${step.formStage.id}`
  if (step?.uiState?.id) return `${route}::ui:${step.uiState.id}`
  if (step?.kind === 'unhappy' && step.state) {
    const slug = String(step.state)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48)
    return `${route}::state:${slug || 'error'}`
  }
  return route
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

/**
 * React Router framework-mode configs: route("path", "./file.tsx") / index("./page.tsx").
 * Used by Plane and similar apps instead of JSX <Route path>.
 */
function reactRouterConfigScreens(files) {
  const found = []
  const seen = new Set()
  const add = (routePath, entryHint, fromFile) => {
    if (!routePath || routePath === '*') return
    const raw = routePath.startsWith('/') ? routePath : `/${routePath}`
    const clean = normalizeRoute(raw.replace(/:([\w]+)/g, '[$1]'))
    if (!clean || seen.has(clean)) return
    const rel = String(entryHint || '').replace(/^\.\//, '')
    const entry =
      (rel && resolveImport(fromFile, `./${rel}`, files)) ||
      (rel && joinPath(dirname(fromFile), rel)) ||
      fromFile
    if (files[entry] === undefined && rel) {
      // Still keep the route even if the page file was truncated out of the read set.
      seen.add(clean)
      found.push({ name: screenLabel(clean), entry: entry || fromFile, route: clean, pattern: routePattern(clean) })
      return
    }
    seen.add(clean)
    found.push({ name: screenLabel(clean), entry: files[entry] !== undefined ? entry : fromFile, route: clean, pattern: routePattern(clean) })
  }
  for (const [file, code] of Object.entries(files)) {
    if (!/\broute\s*\(|\bindex\s*\(/.test(code)) continue
    for (const match of code.matchAll(/\broute\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*["'`]([^"'`]+)["'`]/g)) {
      add(match[1], match[2], file)
    }
    for (const match of code.matchAll(/\bindex\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
      add('/', match[1], file)
    }
  }
  return found
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
          // Each real slug keeps its own pattern so Analytics is not summed across /writing/*
          for (const page of pages) add(page, routePattern(page), entry)
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
  /alert\(\s*"([^"]{6,120})"|alert\(\s*'([^']{6,120})'|alert\(\s*`([^`]{6,120})`/,
  /set(?:[A-Z]\w*)?Error\(\s*"([^"]{6,120})"|set(?:[A-Z]\w*)?Error\(\s*'([^']{6,120})'|set(?:[A-Z]\w*)?Error\(\s*`([^`]{6,120})`/,
  />\s*([^<]{0,90}(?:empty|not found|no [\w ]+|failed|try again|went wrong|unavailable)[^<]{0,40})\s*</i,
  /title:\s*"([^"]{4,80}(?:not found|empty|failed|unavailable)[^"]{0,40})"|title:\s*'([^']{4,80}(?:not found|empty|failed|unavailable)[^']{0,40})'/i,
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
    const phrase = (match?.slice(1).find(Boolean) || '').replace(/\s+/g, ' ').trim()
    if (phrase && phrase.length >= 6 && phrase.length <= 120 && !phrase.includes('${')) return phrase
  }
  return null
}

export function mapProject(files, frameworkId) {
  const constants = pathConstants(files)
  const fromConfig = frameworkId === 'next' ? [] : reactRouterConfigScreens(files)
  const routed = frameworkId === 'next' ? [] : fromConfig.length ? fromConfig : routerScreens(files, constants)
  const rankRoute = (route) => {
    const p = String(route || '')
    if (p === '/' || /^\/[^/]+$/.test(p)) return 0
    if (/\/(projects|issues|cycles|modules|pages|intake|views|active-cycles|notifications|drafts)(\/|$)/.test(p)) return 1
    if (/\/(login|sign-up|onboarding|create-workspace|account)(\/|$)/.test(p)) return 2
    if (/\/(settings|billing|webhooks|exports|integrations)(\/|$)/.test(p)) return 5
    if (/\/(about|faq|privacy|terms)/.test(p)) return 6
    return 3
  }
  let screens = routed.length
    ? [...routed].sort((a, b) => rankRoute(a.route) - rankRoute(b.route) || a.route.localeCompare(b.route)).slice(0, 64)
    : pageEntries(files, frameworkId)
        .filter((p) => entryRank(p) <= 6)
        .sort((a, b) => entryRank(a) - entryRank(b) || a.localeCompare(b))
        .slice(0, 64)
        .map((entry) => {
          const route = routeOf(entry)
          return { name: screenLabel(entry), entry, route, pattern: routePattern(route) }
        })

  // Always merge real app page.tsx routes so a sparse/false route() hit cannot
  // drop the product spine (Plane workspace home, projects, …).
  if (frameworkId === 'react-router' || frameworkId === 'next') {
    const have = new Set(screens.map((s) => s.route))
    for (const entry of pageEntries(files, frameworkId).filter((p) => entryRank(p) <= 6)) {
      const route = routeOf(entry)
      if (!route || have.has(route)) continue
      // Skip component folders named pages/ that are not under app/
      if (!/(^|\/)(src\/)?app\//.test(entry)) continue
      have.add(route)
      screens.push({ name: screenLabel(route), entry, route, pattern: routePattern(route) })
    }
    screens.sort((a, b) => rankRoute(a.route) - rankRoute(b.route) || a.route.localeCompare(b.route))
    screens = screens.slice(0, 64)
  }

  const seenRoutes = new Set()
  screens = screens.filter((s) => {
    if (seenRoutes.has(s.route)) return false
    seenRoutes.add(s.route)
    return true
  })

  const mapped = screens.map((s) => {
    const direct = directImports(s.entry, files)
    const owned = [s.entry, ...direct].filter((file) => files[file] !== undefined)
    const ownedCode = owned.map((file) => files[file]).join('\n')
    let stages = formStagesOf(files[s.entry] || '')
    if (stages.length < 2) {
      for (const file of owned) {
        const found = formStagesOf(files[file] || '')
        if (found.length > stages.length) stages = found
      }
    }
    if (stages.length < 2) stages = formStagesOf(ownedCode)
    let uiStates = uiStatesOf(files[s.entry] || '')
    if (!uiStates.length) {
      for (const file of owned) {
        const found = uiStatesOf(files[file] || '')
        if (found.length > uiStates.length) uiStates = found
      }
    }
    if (!uiStates.length) uiStates = uiStatesOf(ownedCode)
    return {
      ...s,
      access: accessOf(s.route, s.entry, files),
      files: screenFiles(s.entry, files),
      direct,
      gestures: gesturesFor(ownedCode),
      stages,
      uiStates,
    }
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
          const cap = /set(?:[A-Z]\w*)?Error\(/.test(line) ? 10 : 3
          if (phrase && fileEvidence < cap) {
            evidence.push({
              file,
              line: i + 1,
              screens: [screen.name],
              phrase,
              snippet: phrase,
              stageId: stageIdForPhrase(files[file], phrase),
            })
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

  evidence.sort((a, b) => {
    const rank = (item) => {
      if (item.stageId) return 0
      if (/please|required|password|email|consent|invalid|match|try again|failed to/i.test(item.phrase || '')) return 1
      return 2
    }
    return rank(a) - rank(b)
  })
  return { screens: mapped.map(({ files: _f, direct: _d, ...s }) => s), links, evidence: evidence.slice(0, 60) }
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

export function buildFlow(id, name, happy, map, byName) {
  const lanes = []
  const steps = []
  const edges = []
  let n = 0
  const happyLane = { id: `${id}-happy`, name: 'Happy path', kind: 'happy' }
  lanes.push(happyLane)
  const stepByScreen = new Map()
  let prev = null
  let col = 0
  happy.forEach((screen) => {
    const stages = screen.stages?.length >= 2 ? screen.stages : [null]
    let screenAnchor = null
    stages.forEach((stage, stageIndex) => {
      const step = {
        id: nid('step', ++n),
        laneId: happyLane.id,
        name: stage ? `${screen.name} · ${stage.label}` : screen.name,
        route: screen.route,
        pattern: screen.pattern || routePattern(screen.route),
        entry: screen.entry,
        access: screen.access || 'public',
        col: col++,
        note: stage ? `${screen.route} · ${stage.label}` : screen.route,
        gestures: screen.gestures || [],
        kind: 'happy',
        formStage: stage ? { id: stage.id, label: stage.label, index: stageIndex } : undefined,
        formStages: stage ? screen.stages : undefined,
      }
      steps.push(step)
      if (stageIndex === 0) {
        stepByScreen.set(screen.name, step)
        screenAnchor = step
      }
      if (stage) stepByScreen.set(`${screen.name}::${stage.id}`, step)
      if (prev) edges.push({ id: nid('edge', ++n), from: prev.id, to: step.id })
      prev = step
    })

    // Entry hub (usually Dashboard) is only a pin into the journey — don't
    // repeat its overlays on every product path.
    const isEntryPin = screen === happy[0] && happy.length > 1
    const overlays = isEntryPin ? [] : (screen.uiStates || []).slice(0, 4)
    if (overlays.length && screenAnchor) {
      let overlayLane = null
      const overlayCols = new Set()
      for (const ui of overlays) {
        if (!overlayLane) {
          overlayLane = { id: nid('lane', ++n), name: 'On this screen', kind: 'overlay' }
          lanes.push(overlayLane)
        }
        let overlayCol = screenAnchor.col
        while (overlayCols.has(overlayCol)) overlayCol += 1
        overlayCols.add(overlayCol)
        const step = {
          id: nid('step', ++n),
          laneId: overlayLane.id,
          name: ui.label,
          route: screen.route,
          pattern: screenAnchor.pattern,
          entry: screen.entry,
          access: screen.access || 'public',
          col: overlayCol,
          note: ui.openable ? `Opens via: ${(ui.triggers || []).slice(0, 2).join(' · ') || ui.id}` : `In-page state · ${ui.id}`,
          gestures: screen.gestures || [],
          kind: 'overlay',
          uiState: ui,
        }
        steps.push(step)
        edges.push({ id: nid('edge', ++n), from: screenAnchor.id, to: step.id, label: ui.kind === 'mode' ? 'when' : 'opens' })
      }
    }
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
    if (unhappy++ >= 8) break
    const stageId = group.evidence.stageId
    const from =
      (stageId && stepByScreen.get(`${group.screen}::${stageId}`)) || stepByScreen.get(group.screen)
    if (!from) continue
    if (!stateLane) {
      stateLane = { id: nid('lane', ++n), name: 'When it goes wrong', kind: 'unhappy' }
      lanes.push(stateLane)
    }
    let stateCol = from.col
    while (stateCols.has(stateCol)) stateCol += 1
    stateCols.add(stateCol)
    let matchedStage = from.formStage
    if (stageId && from.formStages?.length) {
      const index = from.formStages.findIndex((s) => s.id === stageId)
      if (index >= 0) matchedStage = { id: stageId, label: from.formStages[index].label, index }
    }
    const step = {
      id: nid('step', ++n),
      laneId: stateLane.id,
      name: group.phrase,
      route: from.route,
      pattern: from.pattern || routePattern(from.route),
      entry: from.entry,
      col: stateCol,
      note: group.phrase,
      evidence: `${group.evidence.file}:${group.evidence.line}`,
      kind: 'unhappy',
      state: group.phrase,
      stateKind: group.kind,
      formStage: matchedStage,
      formStages: from.formStages,
    }
    steps.push(step)
    edges.push({ id: nid('edge', ++n), from: from.id, to: step.id })
  }

  return { id, name, lanes, steps, edges }
}

const CONTINUATIONS = new Set(['cart', 'checkout', 'order-success', 'login', 'signup', 'sign-in', 'sign-up'])

function sectionOf(route) {
  return route.split('/').filter(Boolean)[0]?.toLowerCase() || ''
}

function titleCase(value) {
  return value.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Routes that are product chrome even when the page file is a client component. */
const PRODUCT_ROUTE =
  /^\/(dashboard|onboarding|link-person|account|settings|sharing|backups|people|tree|archivist|videos|orders|admin|graph|hints)(\/|$)/i

function isMarketingRoute(route) {
  const path = String(route || '')
  if (path === '/' || path === '') return true
  return /^\/(features|faq|about|guides|privacy-policy|terms-of-service|how-to|from-|parents|nostalgic|familytree|design|setup)(\/|$)/i.test(
    path,
  )
}

/** Public marketing vs signed-in product vs the sign-in/sign-up shell. */
export function accessOf(route, entry, files) {
  const path = String(route || '')
  if (/^\/(login|sign-in|signin|sign-up|signup|register|forgot-password|reset-password)(\/|$)/i.test(path)) {
    return 'auth'
  }
  if (PRODUCT_ROUTE.test(path) && !isMarketingRoute(path)) return 'signed-in'
  const source = files?.[entry] || ''
  if (!source) return 'public'
  // Auth helpers and “bounce anonymous users to login”.
  if (/\brequire(?:Auth|Owner|Editor)\s*\(/.test(source)) return 'signed-in'
  if (/\bredirect\s*\(\s*['"`]\/(login|sign-in|signin|sign-up|signup)['"`]/.test(source)) return 'signed-in'
  if (/\bgetSession\s*\(/.test(source) && /redirect\s*\(\s*['"`]\/(login|sign-in|signin|sign-up|signup)['"`]/.test(source)) {
    return 'signed-in'
  }
  return 'public'
}

/** Dashboard (and friends) plus every non-marketing screen they link into. */
export function productScreens(map) {
  const byName = new Map(map.screens.map((s) => [s.name, s]))
  const seeds = map.screens.filter((s) => s.access === 'signed-in')
  const out = new Map(seeds.map((s) => [s.name, { ...s, access: 'signed-in' }]))
  const queue = seeds.map((s) => s.name)
  const seen = new Set(queue)
  while (queue.length) {
    const from = queue.shift()
    for (const link of map.links) {
      if (link.from !== from || link.conditional) continue
      const dest = byName.get(link.to)
      if (!dest || seen.has(dest.name)) continue
      if (dest.access === 'auth' || isMarketingRoute(dest.route)) continue
      seen.add(dest.name)
      out.set(dest.name, { ...dest, access: 'signed-in' })
      queue.push(dest.name)
    }
  }
  return [...out.values()]
}

function journeyTitle(section, homeRoute) {
  const key = String(section || '').toLowerCase()
  const titles = {
    onboarding: 'First-use onboarding',
    people: 'People',
    tree: 'Family tree',
    archivist: 'Record & review',
    settings: 'Settings & privacy',
    sharing: 'Invite & sharing',
    backups: 'Backups',
    account: 'Account',
    videos: 'Videos',
    admin: 'Orders',
    orders: 'Order success',
    graph: 'Graph view',
    hints: 'Hints',
    dashboard: 'Dashboard',
  }
  if (titles[key]) return titles[key]
  if (key === sectionOf(homeRoute)) return 'Signed-in home'
  return titleCase(key || 'Signed in')
}

/** Prefer hubs (`/people`) before wizards (`/people/new`) and demote archives. */
function routePriority(route) {
  const parts = String(route || '')
    .split('/')
    .filter(Boolean)
  let score = parts.length
  if (/\[/.test(route)) score += 2
  if (/\/(new|edit|manage|upload|split|review)(\/|$)/.test(route)) score += 0.5
  if (/\/(archive|svg|simple)(\/|$)/.test(route) || /\/tree\/family$/.test(route)) score += 8
  return score
}

function assembleFromHome(map, home, screens, { idPrefix = 'flow', leftoverName = 'Other screens', leftoverLimit = 10 } = {}) {
  if (!home || !screens.length) return []
  const byName = new Map(screens.map((s) => [s.name, s]))
  const nameSet = new Set(screens.map((s) => s.name))
  const hops = []
  const seenHop = new Set()
  for (const link of map.links) {
    if (link.from !== home.name || link.conditional || link.to === home.name || seenHop.has(link.to)) continue
    const dest = byName.get(link.to)
    if (!dest || CONTINUATIONS.has(sectionOf(dest.route))) continue
    if (dest.access === 'signed-in' && home.access !== 'signed-in') continue
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
  const outgoing = (name) => map.links.filter((l) => l.from === name && !l.conditional && nameSet.has(l.to))
  const byPriority = (a, b) => routePriority(a.route) - routePriority(b.route) || a.route.localeCompare(b.route)

  for (const [key, group] of groups) {
    // Keep each journey inside its route section. Do not spill every signed-in
    // screen into every path — that produced one giant “Signed in” spine.
    const sectionScreens = screens.filter(
      (s) =>
        sectionOf(s.route) === key ||
        CONTINUATIONS.has(sectionOf(s.route)) ||
        s.name === home.name,
    )
    const primary = sectionScreens.filter((s) => routePriority(s.route) < 8 || s.name === home.name)
    const allowed = new Set(primary.map((s) => s.name))
    const path = [home]
    const seen = new Set([home.name])
    const siblings = primary.filter((s) => sectionOf(s.route) === key && !group.includes(s))
    const queue = [...group].sort(byPriority).concat(siblings.sort(byPriority))
    while (queue.length && path.length < 14) {
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
    const title =
      home.access === 'signed-in' || idPrefix === 'app' ? journeyTitle(key, home.route) : titleCase(key)
    flows.push(buildFlow(`${idPrefix}-${flows.length + 1}`, title, ordered, map, byName))
    ordered.forEach((s) => used.add(s.name))
  }

  if (!flows.length) {
    const path = walkFrom(home, byName, map, new Set(), 10)
    flows.push(buildFlow(idPrefix === 'app' ? 'signed-in' : 'main', idPrefix === 'app' ? 'Signed in' : 'Main journey', path, map, byName))
    path.forEach((s) => used.add(s.name))
  }

  // Sections not linked from the hub (e.g. Videos) still get their own journey when dense enough.
  const leftoverBySection = new Map()
  for (const screen of screens) {
    if (used.has(screen.name) || screen.name === home.name) continue
    if (routePriority(screen.route) >= 8) continue
    const key = sectionOf(screen.route)
    if (!key) continue
    if (!leftoverBySection.has(key)) leftoverBySection.set(key, [])
    leftoverBySection.get(key).push(screen)
  }
  for (const [key, group] of leftoverBySection) {
    if (group.length < 2) continue
    const ordered = [home, ...group.sort(byPriority)].slice(0, 12)
    const title =
      home.access === 'signed-in' || idPrefix === 'app' ? journeyTitle(key, home.route) : titleCase(key)
    flows.push(buildFlow(`${idPrefix}-${flows.length + 1}`, title, ordered, map, byName))
    ordered.forEach((s) => used.add(s.name))
  }

  const leftovers = screens.filter((s) => !used.has(s.name)).slice(0, leftoverLimit)
  if (leftovers.length) flows.push(buildFlow(`${idPrefix}-other`, leftoverName, leftovers, map, byName))
  return flows.filter((flow) => flow.steps.length)
}

/**
 * Public marketing journeys from `/`, plus a separate signed-in area when
 * pages redirect to login / call requireAuth.
 */
export function assemble(map) {
  const screens = map.screens
  if (!screens.length) return []

  const publicScreens = screens.filter((s) => s.access !== 'signed-in')
  const publicHome = publicScreens.find((s) => s.route === '/') ?? publicScreens[0]

  const flows = assembleFromHome(map, publicHome, publicScreens, {
    idPrefix: 'flow',
    leftoverName: 'Other public screens',
    leftoverLimit: 12,
  })

  const product = productScreens(map)
  if (product.length) {
    const appHome =
      product.find((s) => s.route === '/dashboard') ||
      product.find((s) => /^\/(app|home|account|projects)\/?$/.test(s.route)) ||
      product[0]
    // Same section-splitting as marketing, from the signed-in hub.
    const productMap = { ...map, screens: product }
    const appFlows = assembleFromHome(productMap, appHome, product, {
      idPrefix: 'app',
      leftoverName: 'More signed-in screens',
      leftoverLimit: 16,
    })
    flows.push(...appFlows)
  }

  return flows.filter((flow) => flow.steps.length)
}
