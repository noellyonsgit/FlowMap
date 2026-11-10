import test from 'node:test'
import assert from 'node:assert/strict'
import { formStagesOf, stageIdForPhrase, shotKeyFor, uiStatesOf } from './map.js'

const SAMPLE = `
type Stage = 'welcome' | 'credentials' | 'tree' | 'consent'
const STAGES: Stage[] = ['welcome', 'credentials', 'tree', 'consent']
const STAGE_LABELS = {
  welcome: 'Welcome',
  credentials: 'Account Details',
  tree: 'Your Family Tree',
  consent: 'Privacy & Consent',
}
function validateCurrentStage() {
  if (currentStage === 'welcome') {
    setError('Please tell us your name so we can personalize your experience.')
  }
  if (currentStage === 'credentials') {
    setError("Your passwords don't match. Please try again.")
  }
}
`

test('formStagesOf reads STAGE_LABELS', () => {
  assert.deepEqual(formStagesOf(SAMPLE).map((s) => s.id), ['welcome', 'credentials', 'tree', 'consent'])
})

test('stageIdForPhrase finds the owning wizard step', () => {
  assert.equal(stageIdForPhrase(SAMPLE, 'Please tell us your name so we can personalize your experience.'), 'welcome')
  assert.equal(stageIdForPhrase(SAMPLE, "Your passwords don't match. Please try again."), 'credentials')
})

test('shotKeyFor keeps form stages distinct on one route', () => {
  assert.equal(shotKeyFor({ route: '/signup', formStage: { id: 'tree' } }), '/signup::stage:tree')
  assert.equal(
    shotKeyFor({ route: '/signup', kind: 'unhappy', state: 'Please enter a valid email address' }),
    '/signup::state:please-enter-a-valid-email-address',
  )
})

test('formStagesOf reads onboarding-style steps arrays', () => {
  const code = `
const steps = [
  { id: 'welcome', question: "Welcome! Let's begin.", type: 'action' },
  { id: 'name', question: "What's your name?", type: 'text', field: 'name' },
  { id: 'gender', question: 'What is your gender?', type: 'select', field: 'gender' },
]
`
  assert.deepEqual(
    formStagesOf(code).map((s) => s.id),
    ['welcome', 'name', 'gender'],
  )
  assert.equal(formStagesOf(code)[1].label, "What's your name?")
})

test('uiStatesOf finds modal toggles and click labels', () => {
  const code = `
    const [showOrderModal, setShowOrderModal] = useState(false)
    const [inviteOpen, setInviteOpen] = useState(false)
    return (
      <>
        <button onClick={() => setShowOrderModal(true)}>Order print</button>
        <button aria-label="Invite family" onClick={() => setInviteOpen(true)}>Share</button>
        {showOrderModal && <Dialog>Order</Dialog>}
        <Sheet open={inviteOpen} />
      </>
    )
  `
  const states = uiStatesOf(code)
  assert.ok(states.some((s) => /order/i.test(s.id) && s.triggers.includes('Order print')))
  assert.ok(states.some((s) => /invite/i.test(s.id)))
})

test('uiStatesOf finds page mode enums without treating them as clickable', () => {
  const code = `
    let dashboardState: 'celebration' | 'normal' = 'normal'
    if (dashboardState === 'celebration') return <Celebration />
    if (dashboardState === 'normal') return <Home />
  `
  const modes = uiStatesOf(code).filter((s) => s.kind === 'mode')
  assert.deepEqual(
    modes.map((s) => s.id),
    ['celebration'],
  )
  assert.equal(modes[0].openable, false)
})

test('formStagesOf keeps long onboarding steps', () => {
  const code = `
const steps = [
  {
    id: 'welcome',
    question: answers.name
      ? \`Welcome, \${answers.name}!\`
      : "Welcome! I'm The Archivist.",
    type: 'action',
  },
  { id: 'name', question: "What's your name?", type: 'text', field: 'name' },
  {
    id: 'gender',
    question: 'What is your gender?',
    type: 'select',
    options: [{ label: 'Male', value: 'male' }, { label: 'Female', value: 'female' }],
  },
  { id: 'this_is_you', question: "This is you!", type: 'action' },
]
`
  assert.deepEqual(
    formStagesOf(code).map((s) => s.id),
    ['welcome', 'name', 'gender', 'this_is_you'],
  )
  assert.equal(formStagesOf(code)[0].label, "Welcome! I'm The Archivist.")
})
