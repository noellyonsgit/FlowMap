import test from 'node:test'
import assert from 'node:assert/strict'
import { projectLinks, scoreFlow, scoreFlows } from './score.js'

function sampleFlows() {
  const flowA = {
    id: 'flow-1',
    name: 'Shop',
    lanes: [
      { id: 'happy', name: 'Happy path', kind: 'happy' },
      { id: 'bad', name: 'When it goes wrong', kind: 'unhappy' },
    ],
    steps: [
      { id: 's1', laneId: 'happy', name: 'Home', route: '/', col: 0, kind: 'happy', gestures: [] },
      { id: 's2', laneId: 'happy', name: 'Shop', route: '/shop', col: 1, kind: 'happy', gestures: ['Form'] },
      { id: 's3', laneId: 'happy', name: 'Cart', route: '/cart', col: 2, kind: 'happy', gestures: [] },
      {
        id: 'u1',
        laneId: 'bad',
        name: 'No prints available yet.',
        route: '/shop',
        col: 1,
        kind: 'unhappy',
        state: 'No prints available yet.',
        stateKind: 'empty',
        evidence: 'shop.tsx:12',
      },
    ],
    edges: [
      { id: 'e1', from: 's1', to: 's2' },
      { id: 'e2', from: 's2', to: 's3' },
      { id: 'e3', from: 's2', to: 'u1' },
    ],
  }
  const flowB = {
    id: 'flow-2',
    name: 'Account',
    lanes: [{ id: 'happy', name: 'Happy path', kind: 'happy' }],
    steps: [
      { id: 'a1', laneId: 'happy', name: 'Home', route: '/', col: 0, kind: 'happy', gestures: [] },
      { id: 'a2', laneId: 'happy', name: 'Account', route: '/account', col: 1, kind: 'happy', gestures: ['Form'] },
    ],
    edges: [{ id: 'ae1', from: 'a1', to: 'a2' }],
  }
  return [flowA, flowB]
}

test('Pack A scores are reproducible for the same flows', () => {
  const flows = sampleFlows()
  const first = scoreFlows(flows)
  const second = scoreFlows(JSON.parse(JSON.stringify(flows)))
  assert.equal(first.version, 1)
  assert.equal(first.flows.length, 2)
  assert.deepEqual(
    first.flows.map((flow) => ({ id: flow.flowId, overall: flow.overall, dims: flow.dimensions.map((d) => [d.id, d.score]) })),
    second.flows.map((flow) => ({ id: flow.flowId, overall: flow.overall, dims: flow.dimensions.map((d) => [d.id, d.score]) })),
  )
})

test('Pack A attaches evidence to every contributing check', () => {
  const scored = scoreFlow(sampleFlows()[0], sampleFlows())
  assert.ok(scored.overall >= 1 && scored.overall <= 5)
  for (const dim of scored.dimensions) {
    for (const item of dim.checks) {
      if (item.status === 'unavailable') continue
      assert.ok(Array.isArray(item.evidence), `${item.id} needs evidence`)
      assert.ok(item.reading, `${item.id} needs plain-language reading`)
    }
  }
  assert.ok(scored.story?.blurb)
  assert.ok(scored.story.helped.length + scored.story.held.length > 0)
  const e1 = scored.dimensions.find((dim) => dim.id === 'resilience').checks.find((item) => item.id === 'E1')
  assert.equal(e1.status, 'pass')
})

test('projectLinks keeps journey edges out of the underlay', () => {
  const [flow] = sampleFlows()
  const map = {
    links: [
      { from: 'Home', to: 'Shop', conditional: false, context: '' },
      { from: 'Shop', to: 'Cart', conditional: false, context: '' },
      { from: 'Home', to: 'Cart', conditional: false, context: 'skip' },
      { from: 'Shop', to: 'Account', conditional: false, context: '' },
    ],
  }
  const links = projectLinks(flow, map)
  assert.deepEqual(
    links.map((link) => `${link.fromName}->${link.toName}`),
    ['Home->Cart'],
  )
})
