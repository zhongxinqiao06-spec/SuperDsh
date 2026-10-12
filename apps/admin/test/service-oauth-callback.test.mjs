import assert from 'node:assert/strict'
import test from 'node:test'
import { registerSource } from './helpers/onboarding-source.mjs'

const source = registerSource()
const { webOAuthRedirectUrl } =
  await import('../src/components/pages/service-page.tsx')
source.deregister()

test('service settings show the registered API v2 OAuth callback', () => {
  assert.equal(
    webOAuthRedirectUrl('https://platform.example.test'),
    'https://platform.example.test/api/v2/auth/oauth/callback',
  )
})

test('development callback retains the public proxy origin and port', () => {
  assert.equal(
    webOAuthRedirectUrl('http://127.0.0.1:5174/'),
    'http://127.0.0.1:5174/api/v2/auth/oauth/callback',
  )
})
