import fs from 'node:fs'
import path from 'node:path'

const TEXT = /\.(jsx?|tsx?|mjs|cjs|vue|svelte|astro|html?|css|json)$/i
const IGNORE = /(^|\/)(node_modules|\.git|\.next|\.nuxt|dist|build|out|coverage|\.turbo|\.vercel|\.cache)(\/|$)/

function priority(rel) {
  const p = rel.replace(/\\/g, '/')
  if (/(^|\/)(package\.json|vite\.config\.[cm]?[jt]s|next\.config\.[cm]?[jt]s)$/.test(p)) return 0
  if (/(^|\/)(src\/)?app\/(?:.+\/)?page\.(t|j)sx$/.test(p)) return 1
  if (/(^|\/)(src\/)?pages\/(?!api\/).+\.(t|j)sx$/.test(p)) return 1
  if (/(^|\/)(src\/)?(components|views|screens|features)\/.+\.(t|j)sx$/.test(p)) return 2
  if (/(^|\/)(src\/)?(lib|hooks|utils)\/.+/.test(p)) return 3
  if (/\.(css|vue|svelte|astro|html?)$/.test(p)) return 4
  return 6
}

/** Read source text for mapping. Skips deps, build output, and huge files. */
export function readProject(root, limit = 700) {
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
