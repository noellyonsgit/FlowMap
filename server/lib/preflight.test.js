import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { badges, screenshotPath } from './preflight.js'

const flows = [
  {
    steps: [
      { id: 'a', route: '/' },
      { id: 'b', route: '/prints/q/summer', resolvedFrom: '/prints/q/[slug]' },
    ],
  },
]

test('findings land on the screen they name, including dynamic routes', () => {
  const findings = [
    { key: '1', phase: 'standards', severity: 'P1', status: 'open', screens: ['/', '/prints/q/winter'] },
    { key: '2', phase: 'devices', severity: 'P0', status: 'open', screen: '/prints/q/summer' },
    { key: '3', phase: 'security', severity: 'P0', status: 'open', file: 'package.json' },
    { key: '4', phase: 'states', severity: 'P1', status: 'fixed', screen: '/' },
  ]
  const result = badges(findings, flows)
  assert.equal(result.byStep.a.access, 1)
  assert.equal(result.byStep.a.errors, 0, 'fixed findings are not counted')
  assert.equal(result.byStep.b.access, 1, '/prints/q/winter matches the [slug] pattern')
  assert.equal(result.byStep.b.mobile, 1)
  assert.equal(result.byStep.b.worst, 'P0')
  assert.deepEqual(result.sitewide, ['3'])
})

test('only screenshots inside .preflight are served', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowmap-pf-'))
  fs.mkdirSync(path.join(root, '.preflight', 'diff'), { recursive: true })
  fs.writeFileSync(path.join(root, '.preflight', 'diff', 'home@iphone.png'), 'x')
  fs.writeFileSync(path.join(root, 'secret.png'), 'x')
  assert.ok(screenshotPath(root, 'diff/home@iphone.png'))
  assert.equal(screenshotPath(root, '../secret.png'), null)
  assert.equal(screenshotPath(root, 'findings.json'), null)
  fs.rmSync(root, { recursive: true, force: true })
})
