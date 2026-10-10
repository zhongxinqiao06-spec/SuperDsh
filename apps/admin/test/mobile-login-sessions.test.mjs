import assert from 'node:assert/strict'
import test from 'node:test'
import { registerSource } from './helpers/onboarding-source.mjs'

const hooks = registerSource()
const { isMobileLoginSession, mobileLoginSessions } =
  await import('../src/features/mobile-connections/login-sessions.ts')
hooks.deregister()

const now = Date.parse('2026-10-09T00:00:00Z')
function session(id, clientName, extra = {}) {
  return {
    id,
    clientName,
    createdAt: '2026-10-01T00:00:00Z',
    lastSeenAt: '2026-10-02T00:00:00Z',
    expiresAt: '2026-11-01T00:00:00Z',
    current: false,
    ...extra,
  }
}

test('the known password, OAuth, and QR mobile client names classify display records', () => {
  for (const name of [
    'SuperDsh Android',
    'agents-anywhere-mobile',
    'Mobile',
    ' mobile ',
  ])
    assert.equal(isMobileLoginSession(session(name, name)), true)
  for (const name of [
    'Browser',
    'SuperDsh Desktop',
    'Custom Android',
    'Mobile browser',
    '',
  ])
    assert.equal(isMobileLoginSession(session(name, name)), false)
})

test('multiple logins from the same client remain separate sessions, not unique phones', () => {
  const records = [
    session('one', 'SuperDsh Android'),
    session('two', 'SuperDsh Android'),
  ]
  assert.deepEqual(
    mobileLoginSessions(records, now).map((item) => item.id),
    ['one', 'two'],
  )
  assert.equal(records.length, 2)
})

test('expired, malformed, and non-mobile sessions do not appear as valid mobile sign-ins', () => {
  const records = [
    session('valid', 'Mobile'),
    session('expired', 'Mobile', { expiresAt: '2026-10-08T00:00:00Z' }),
    session('exact-expiry', 'Mobile', { expiresAt: '2026-10-09T00:00:00Z' }),
    session('malformed', 'Mobile', { expiresAt: 'not-a-date' }),
    session('browser', 'Browser'),
  ]
  assert.deepEqual(
    mobileLoginSessions(records, now).map((item) => item.id),
    ['valid'],
  )
})

test('newest login sorts first without mutating the response or inventing online status', () => {
  const old = session('old', 'Mobile', { createdAt: '2026-09-01T00:00:00Z' })
  const recent = session('new', 'Mobile')
  const records = [old, recent]
  assert.deepEqual(mobileLoginSessions(records, now), [recent, old])
  assert.deepEqual(records, [old, recent])
  assert.equal('online' in recent, false)
})
