import assert from 'node:assert/strict'
import test from 'node:test'
import { publicOrigin } from '../identity/routes.ts'

test('public origin ignores forged proxy headers and uses the direct socket', () => {
  const request = {
    headers: {
      host: '127.0.0.1:5174',
      'x-forwarded-host': 'attacker.invalid',
      'x-forwarded-proto': 'https',
    },
    socket: {},
  }
  assert.equal(publicOrigin(request, {}), 'http://127.0.0.1:5174')
  request.socket.encrypted = true
  assert.equal(publicOrigin(request, {}), 'https://127.0.0.1:5174')
  assert.equal(
    publicOrigin(request, {
      AGENT_SERVER_PUBLIC_ORIGIN: 'https://platform.example:443/',
    }),
    'https://platform.example',
  )
})

test('configured public origin rejects credentials, paths and non-HTTP schemes', () => {
  const request = { headers: { host: '127.0.0.1' }, socket: {} }
  for (const value of [
    'invalid',
    'javascript:alert(1)',
    'https://user:pass@example.com',
    'https://example.com/path',
    'https://example.com/?redirect=https://attacker.invalid',
    'https://example.com/#fragment',
  ]) {
    assert.throws(
      () => publicOrigin(request, { AGENT_SERVER_PUBLIC_ORIGIN: value }),
      /invalid public origin/,
    )
  }
})
