import fs from 'node:fs'
import path from 'node:path'

const TEXT = /\.(jsx?|tsx?|mjs|cjs|vue|svelte|astro|html?|css|json)$/i
const IGNORE = /(^|\/)(node_modules|\.git|\.next|\.nuxt|dist|build|out|coverage|\.turbo|\.vercel|\.cache|synthetic-data|sampleData)(\/|$)/

/** Nested folders that often hold the web app in a monorepo. */
const WEB_CANDIDATES = [
  'frontend',
  'web',
  'client',
  'app',
  'apps/web',
  'apps/frontend',
  'apps/client',
  'packages/web',
  'packages/frontend',
  'packages/client',
]

function priority(rel) {
  const p = rel.replace(/\\/g, '/')
  if (/(^|\/)(package\.json|vite\.config\.[cm]?[jt]s|next\.config\.[cm]?[jt]s)$/.test(p)) return 0
  // React Router / Remix route tables must win over deep component pages.
  if (/(^|\/)(src\/)?app\/routes\.(t|j)sx?$/.test(p) || /(^|\/)(src\/)?app\/routes\/.+\.(t|j)sx?$/.test(p)) return 0
  if (/(^|\/)(src\/)?app\/(?:.+\/)?page\.(t|j)sx$/.test(p)) return 1
  if (/(^|\/)(src\/)?pages\/(?!api\/).+\.(t|j)sx$/.test(p)) return 1
  if (/(^|\/)(src\/)?(components|views|screens|features)\/.+\.(t|j)sx$/.test(p)) return 2
  if (/(^|\/)(src\/)?(lib|hooks|utils)\/.+/.test(p)) return 3
  if (/\.(css|vue|svelte|astro|html?)$/.test(p)) return 4
  return 6
}

function packageHasWebFramework(pkg) {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies }
  return Boolean(deps?.next || deps?.nuxt || deps?.vite || deps?.['@sveltejs/kit'] || deps?.vue)
}

/** Read source text for mapping. Skips deps, build output, and huge files. */
export function readProject(root, limit = 1200) {
  const found = []
  const walk = (dir, rel) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (IGNORE.test(relPath)) continue
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(abs, relPath)
      else if (TEXT.test(entry.name)) found.push(relPath)
    }
  }
  walk(root, '')
  found.sort((a, b) => priority(a) - priority(b) || a.localeCompare(b))
  const files = {}
  for (const relPath of found) {
    if (Object.keys(files).length >= limit) break
    try {
      const abs = path.join(root, relPath)
      if (fs.statSync(abs).size > 200_000) continue
      files[relPath] = fs.readFileSync(abs, 'utf8')
    } catch {
      /* unreadable file */
    }
  }
  return files
}

export function readPackage(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  } catch {
    return {}
  }
}

/**
 * Prefer the folder that actually has Next/Vite/etc.
 * Monorepos like FlowStatus keep the app under frontend/ while the
 * folder people pick is the repo root.
 */
export function resolveWebApp(folder) {
  const rootPkg = readPackage(folder)
  if (packageHasWebFramework(rootPkg)) {
    return { appPath: folder, pkg: rootPkg, nested: false }
  }

  for (const rel of WEB_CANDIDATES) {
    const appPath = path.join(folder, ...rel.split('/'))
    if (!fs.existsSync(path.join(appPath, 'package.json'))) continue
    const pkg = readPackage(appPath)
    if (!packageHasWebFramework(pkg)) continue
    return { appPath, pkg, nested: true, relative: rel }
  }

  try {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || IGNORE.test(entry.name)) continue
      const appPath = path.join(folder, entry.name)
      if (!fs.existsSync(path.join(appPath, 'package.json'))) continue
      const pkg = readPackage(appPath)
      if (!packageHasWebFramework(pkg)) continue
      return { appPath, pkg, nested: true, relative: entry.name }
    }
  } catch {
    /* unreadable folder */
  }

  return { appPath: folder, pkg: rootPkg, nested: false }
}
