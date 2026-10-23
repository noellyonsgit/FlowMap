import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { clientFromDownload } from './google.js'
import { attachChanges, groupCommits, parseChangelog, parseGitLog, plainSubject } from './changes.js'
import { detectAnalytics, eventForEvidence } from './detect.js'
import { describeFlow } from './metrics.js'
import { pathMatches, patternToRegExp, visitsCollapsed } from './match.js'
import { assemble, mapProject, routePattern } from '../map.js'
import { comparisonFor, defaultChangeId } from './windows.js'

test('route patterns match real product addresses', () => {
  assert.equal(routePattern('/prints/[id]'), '/prints/*')
  assert.equal(patternToRegExp('/prints/*').test('/prints/abc'), true)
  assert.equal(pathMatches('/prints/abc?ref=1', '/prints/*'), true)
  assert.equal(pathMatches('/prints/abc/extra', '/prints/*'), false)
  assert.equal(pathMatches('/Checkout/', '/checkout'), true)
  assert.equal(pathMatches('/', '/'), true)
})

test('analytics detection reads tags and nearby events', () => {
  const found = detectAnalytics({
    'src/app/layout.tsx': `export const id = "G-ABC12345"`,
    'src/app/cart/page.tsx': `if (!items.length) return <p>Your cart is empty</p>\ngtag('event', 'empty_cart')`,
  })
  assert.equal(found.measurementId, 'G-ABC12345')
  assert.match(found.line, /Google Analytics/)
  assert.equal(eventForEvidence('src/app/cart/page.tsx:1', found.events), 'empty_cart')
  const gtm = detectAnalytics({ 'index.html': `<script src="https://www.googletagmanager.com/gtm.js?id=GTM-ABCD"></script>` })
  assert.equal(gtm.gtmId, 'GTM-ABCD')
  assert.match(gtm.line, /choose the site/)
  assert.match(detectAnalytics({}).line, /couldn't see a visitor counter/)
})

test('changelog titles win over commit subjects', () => {
  const releases = parseChangelog(`# Changelog\n\n## [1.4.0] - 2026-05-12\n\n- Shorter checkout\n`)
  assert.deepEqual(releases, [{ date: '2026-05-12', title: 'Shorter checkout' }])
  const changes = groupCommits(
    [
      { hash: 'abc1234', date: '2026-05-12', subject: 'feat(checkout): tweak padding' },
      { hash: 'def5678', date: '2026-04-02', subject: 'Merge pull request #4' },
      { hash: 'aaa1111', date: '2026-04-02', subject: 'fix: cart total' },
    ],
    releases,
  )
  assert.equal(changes[0].name, 'Shorter checkout')
  assert.equal(changes[0].source, 'release')
  assert.equal(changes[1].name, 'Cart total')
  assert.equal(plainSubject('feat: hello'), 'Hello')
})

test('git log text becomes commits', () => {
  const commits = parseGitLog(`---\nabc1234\n2026-05-12\nShorter checkout\nsrc/app/checkout/page.tsx\n`)
  assert.equal(commits.length, 1)
  assert.deepEqual(commits[0].files, ['src/app/checkout/page.tsx'])
})

test('a journey change uses the files on that journey', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowmap-'))
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  }
  execFileSync('git', ['init'], { cwd: root, env })
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'page.tsx'), 'export default function Page(){return null}\n')
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '## [1.2.0] - 2026-05-12\n\n- Shorter checkout\n')
  execFileSync('git', ['add', '.'], { cwd: root, env })
  execFileSync('git', ['commit', '-m', 'feat: shorter checkout', '--date=2026-05-12T12:00:00'], { cwd: root, env })
  const flows = [{ id: 'flow-1', steps: [{ entry: 'src/page.tsx' }] }]
  attachChanges(root, flows)
  assert.equal(flows[0].changes.length, 1)
  assert.equal(flows[0].changes[0].name, 'Shorter checkout')
  assert.equal(flows[0].changes[0].source, 'release')
})

test('comparison windows skip the launch day and ask for a week', () => {
  const change = { id: 'c-2026-05-12', day: '2026-05-12' }
  const ready = comparisonFor(change, [change, { id: 'c-2026-05-14', day: '2026-05-14' }], '2026-06-20')
  assert.equal(ready.enough, true)
  assert.equal(ready.after.start, '2026-05-13')
  assert.equal(ready.total, 2)
  const recent = comparisonFor(change, [change], '2026-05-16')
  assert.equal(recent.enough, false)
  assert.equal(defaultChangeId([change], '2026-06-20'), change.id)
  assert.equal(defaultChangeId([change], '2026-05-15'), 'none')
})

test('board lines come from visits, the funnel, and unhappy events', () => {
  const flow = {
    id: 'flow-1',
    changes: [{ id: 'c-2026-05-01', name: 'Shorter checkout', day: '2026-05-01', source: 'commit' }],
    steps: [
      { id: 'a', kind: 'happy', name: 'Cart', route: '/cart', pattern: '/cart', col: 0 },
      { id: 'b', kind: 'happy', name: 'Checkout', route: '/checkout', pattern: '/checkout', col: 1 },
      { id: 'c', kind: 'unhappy', name: 'Your cart is empty', route: '/cart', pattern: '/cart', col: 1, evidence: 'src/cart.tsx:4' },
    ],
  }
  const pages = [
    { path: '/cart', views: 100, duration: 4000 },
    { path: '/checkout', views: 70, duration: 2100 },
  ]
  const described = describeFlow(
    flow,
    { pages, events: [{ eventName: 'empty_cart', path: '/cart', count: 12 }], funnel: [{ users: 100, abandonRate: 0.32 }, { users: 68, abandonRate: 0 }] },
    { pages: [{ path: '/cart', views: 80, duration: 4800 }, { path: '/checkout', views: 40, duration: 1200 }], events: [{ eventName: 'empty_cart', path: '/cart', count: 20 }], funnel: [{ users: 80, abandonRate: 0.41 }, { users: 47, abandonRate: 0 }] },
    { today: new Date(2026, 5, 20), change: flow.changes[0], events: [{ name: 'empty_cart', file: 'src/cart.tsx', line: 5 }] },
  )
  assert.equal(described.headline, 'After Shorter checkout')
  assert.equal(described.finish, '68% finish this path · was 59%')
  assert.equal(described.steps.a.time, 'About 40 seconds here · was about 1 minute')
  assert.equal(described.steps.a.leave, '32% leave before Checkout · was 41%')
  assert.equal(described.steps.c.unhappy, '12% of visits see this · was 25%')
  assert.ok(described.notes.some((note) => note.includes('may have gone live later')))
})

test('a single screen with almost every visit does not invent a funnel', () => {
  assert.equal(visitsCollapsed([{ path: '/', views: 90 }, { path: '/cart', views: 10 }]), true)
  const flow = {
    id: 'main',
    changes: [],
    steps: [
      { id: 'a', kind: 'happy', name: 'Home', route: '/', pattern: '/', col: 0 },
      { id: 'b', kind: 'happy', name: 'Cart', route: '/cart', pattern: '/cart', col: 1 },
    ],
  }
  const described = describeFlow(flow, { pages: [{ path: '/', views: 90, duration: 900 }, { path: '/cart', views: 10, duration: 100 }], events: [], funnel: [{ users: 90, abandonRate: 0.9 }, { users: 9, abandonRate: 0 }] }, null, {})
  assert.match(described.notes[0], /only for the first screen/)
  assert.equal(described.finish, null)
  assert.equal(described.steps.a.leave, undefined)
})

test('named routes and essay slugs become screens', () => {
  const files = {
    'src/data/research.ts': `export const RESEARCH_PATH = '/research/how-design-teams-work-2026'\n`,
    'src/data/writing.ts': `export const WRITING_PATH = '/writing'\nconst telemetry = bySlug('the-enterprise-design-telemetry-crisis')\nconst boring = bySlug('we-dont-have-to-be-boring')\n`,
    'src/App.tsx': `
      import { Research } from './pages/Research'
      import { Essay } from './pages/Essay'
      import { Home } from './pages/Home'
      export function AppRoutes() {
        return <Routes>
          <Route path={RESEARCH_PATH} element={<Research />} />
          <Route path={\`\${WRITING_PATH}/:slug\`} element={<Essay />} />
          <Route path="/" element={<Home />} />
          <Route path="/old" element={<Navigate to="/" replace />} />
        </Routes>
      }
    `,
    'src/pages/Home.tsx': `import { RESEARCH_PATH } from '../data/research'\nexport const nav = [{ to: '/writing', label: 'Writing' }]\nexport function Home(){ return <Link to={RESEARCH_PATH}>Report</Link> }\n`,
    'src/pages/Research.tsx': `export function Research(){ return <h1>Research</h1> }\n`,
    'src/pages/Essay.tsx': `export function Essay(){ return <h1>Essay</h1> }\n`,
  }
  const map = mapProject(files, 'vite')
  const routes = map.screens.map((screen) => screen.route).sort()
  assert.deepEqual(routes, ['/', '/research/how-design-teams-work-2026', '/writing/the-enterprise-design-telemetry-crisis', '/writing/we-dont-have-to-be-boring'])
  const flows = assemble(map)
  const research = flows.find((flow) => flow.steps.some((step) => step.route === '/research/how-design-teams-work-2026'))
  assert.ok(research)
  assert.equal(research.steps[0].route, '/')
})

test('a screen shows how many visits reached it', () => {
  const flow = {
    id: 'main',
    changes: [],
    steps: [
      { id: 'a', kind: 'happy', name: 'Home', route: '/', pattern: '/', col: 0 },
      { id: 'b', kind: 'happy', name: 'Research', route: '/research/how-design-teams-work-2026', pattern: '/research/how-design-teams-work-2026', col: 1 },
    ],
  }
  const described = describeFlow(
    flow,
    {
      pages: [
        { path: '/', views: 192, duration: 626, sessions: 132 },
        { path: '/research/how-design-teams-work-2026/', views: 7, duration: 220, sessions: 6 },
      ],
      events: [],
      summary: { sessions: 199, bounceRate: 0.517, averageSessionDuration: 106 },
    },
    null,
    {},
  )
  assert.equal(described.steps.a.reach, 'Seen in 132 visits')
  assert.equal(described.steps.a.reachCount, 132)
  assert.equal(described.steps.a.time, 'About 5 seconds here')
  assert.equal(described.steps.b.reach, 'Seen in 6 visits')
  assert.equal(described.summary.sessions, 199)
  assert.equal(described.summary.left, 52)
  assert.equal(described.summary.span, 'About 2 minutes')
  assert.equal(describeFlow(flow, { pages: [], events: [], summary: null }, null, {}).summary, null)
})

test('scroll and forms are marked on the screen that uses them', () => {
  const files = {
    'src/App.tsx': `
      import { Home } from './pages/Home'
      import { Story } from './pages/Story'
      export function App() {
        return <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/story" element={<Story />} />
        </Routes>
      }
    `,
    'src/pages/Home.tsx': `import { StoryForm } from './StoryForm'\nexport function Home(){ return <Link to="/story">Story</Link> }\n`,
    'src/pages/Story.tsx': `export function Story(){ return <section whileInView="show">Story</section> }\n`,
    'src/pages/StoryForm.tsx': `export function StoryForm(){ return <form><button type="submit">Send</button></form> }\n`,
  }
  const map = mapProject(files, 'vite')
  const home = map.screens.find((screen) => screen.route === '/')
  const story = map.screens.find((screen) => screen.route === '/story')
  assert.deepEqual(home.gestures, ['Form'])
  assert.deepEqual(story.gestures, ['Scroll'])
})

test('a downloaded Google client keeps the id and secret', () => {
  const saved = clientFromDownload({
    installed: { client_id: 'abc.apps.googleusercontent.com', client_secret: 'secret-value' },
  })
  assert.equal(saved.clientId, 'abc.apps.googleusercontent.com')
  assert.equal(saved.clientSecret, 'secret-value')
  assert.throws(() => clientFromDownload({ client_id: 'abc' }), /not a Google client/)
})
