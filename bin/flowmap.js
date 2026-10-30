#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { VIEWPORTS } from '../server/lib/capture.js'
import { captureFlows, mapFolder, screenList } from '../server/lib/pipeline.js'

const HELP = `flowmap: map the screens and journeys of an app, and screenshot them.

Usage
  flowmap map <folder> [--json]
  flowmap capture <folder> [--url http://localhost:3000] [--viewport iphone|android|tablet|desktop|390x844] [--out <folder>] [--json]

map      Lists every screen, the journeys between them, "When it goes wrong" states and screens nothing links to.
capture  Starts the app (or uses --url), screenshots every screen and saves PNGs to --out
         (default: <folder>/.flowmap/shots/<viewport>).
`

function parse(argv) {
  const out = { _: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json' || a === '--help') out.flags[a.slice(2)] = true
    else if (a.startsWith('--')) out.flags[a.slice(2)] = argv[++i]
    else out._.push(a)
  }
  return out
}

function folderArg(value) {
  const folder = path.resolve(value || '.')
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error(`Not a folder: ${folder}`)
  return folder
}

function summary(mapped) {
  const screens = screenList(mapped)
  return {
    ok: true,
    project: { name: mapped.project.name, path: mapped.project.path, framework: mapped.project.framework },
    stats: mapped.stats,
    screens,
    flows: mapped.flows.map((flow) => ({
      id: flow.id,
      name: flow.name,
      steps: flow.steps.map((s) => ({ name: s.name, route: s.route, kind: s.kind, lane: flow.lanes.find((l) => l.id === s.laneId)?.name, evidence: s.evidence })),
    })),
    unhappy: mapped.flows.flatMap((flow) => flow.steps.filter((s) => s.kind === 'unhappy').map((s) => ({ route: s.route, state: s.state, evidence: s.evidence }))),
    orphans: screens.filter((s) => s.lane === 'Other screens').map((s) => s.route),
  }
}

async function main() {
  const { _: [command, target], flags } = parse(process.argv.slice(2))
  if (!command || flags.help || command === 'help') {
    process.stdout.write(HELP)
    return
  }
  const folder = folderArg(target)

  if (command === 'map') {
    const result = summary(mapFolder(folder))
    if (flags.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    else {
      process.stdout.write(`${result.project.name} (${result.project.framework}): ${result.screens.length} screens, ${result.flows.length} journeys\n`)
      for (const flow of result.flows) process.stdout.write(`  ${flow.name}: ${flow.steps.filter((s) => s.kind !== 'unhappy').map((s) => s.route || s.name).join(' → ')}\n`)
    }
    return
  }

  if (command === 'capture') {
    const mapped = mapFolder(folder)
    const viewportName = flags.viewport || 'desktop'
    const out = path.resolve(flags.out || path.join(folder, '.flowmap', 'shots', viewportName))
    fs.mkdirSync(out, { recursive: true })
    const saved = []
    const { liveUrl, handle } = await captureFlows(mapped.project, mapped.flows, {
      url: flags.url,
      viewport: VIEWPORTS[viewportName] ? viewportName : flags.viewport,
      onShot: (step, png) => {
        const name = `${(step.route === '/' ? 'home' : step.route.replace(/^\/+|\/+$/g, '').replace(/[^a-z0-9]+/gi, '-')).toLowerCase() || 'home'}.png`
        const file = path.join(out, name)
        if (!saved.some((s) => s.file === file)) {
          fs.writeFileSync(file, png)
          saved.push({ route: step.route, file, width: png.readUInt32BE(16), height: png.readUInt32BE(20) })
        }
        return name
      },
    })
    const failed = mapped.flows.flatMap((f) => f.steps.filter((s) => s.shotError).map((s) => ({ route: s.route, error: s.shotError })))
    const result = { ok: true, liveUrl, viewport: viewportName, out, shots: saved, failed }
    if (flags.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    else process.stdout.write(`Saved ${saved.length} screenshots to ${out}${failed.length ? ` (${failed.length} failed)` : ''}\n`)
    if (handle.owned) handle.proc.kill('SIGTERM')
    process.exit(0)
  }

  throw new Error(`Unknown command "${command}". Run: flowmap help`)
}

main().catch((err) => {
  process.stderr.write(`flowmap: ${err.message || err}\n`)
  process.exit(1)
})
