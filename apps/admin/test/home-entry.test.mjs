import assert from 'node:assert/strict'
import test from 'node:test'
import { isWorkspaceEntry } from '../src/features/auth/home-entry.ts'

test('the root and marketing anchors stay public, including campaign queries', () => {
  for (const hash of [
    '',
    '#',
    '#top',
    '#main-content',
    '#capabilities',
    '#workflow',
    '#scenarios',
    '#architecture',
    '#connected',
    '#faq',
    '#start',
  ]) {
    assert.equal(
      isWorkspaceEntry({ hash, search: '?utm_source=launch' }),
      false,
      hash,
    )
  }
})

test('existing console, authentication and native authorization hashes stay in the workspace', () => {
  for (const hash of [
    '#/overview',
    '#/workspace',
    '#/management/users',
    '#/login',
    '#/register',
    '#/bootstrap',
    '#/signed-out',
    '#/preview?path=report.xlsx',
    '#/oauth/new',
    '#/oauth/link',
    '#/onboarding?step=1',
    '#/desktop-oauth?state=desktop',
    '#/mobile-oauth?state=mobile',
    '#/plugin-oauth?state=plugin',
    '#overview',
    '#login',
    '#desktop-oauth?state=legacy',
    '#/unknown-route',
  ]) {
    assert.equal(isWorkspaceEntry({ hash, search: '' }), true, hash)
  }
})

test('OAuth callback parameters take precedence over the public homepage', () => {
  for (const key of [
    'oauth_pending',
    'oauth_status',
    'oauth_user',
    'oauth_email',
    'oauth_display_name',
    'oauth_error',
  ]) {
    assert.equal(
      isWorkspaceEntry({ hash: '', search: `?${key}=fixture` }),
      true,
      key,
    )
    assert.equal(
      isWorkspaceEntry({ hash: '#top', search: `?${key}=fixture` }),
      true,
      key,
    )
  }
  assert.equal(isWorkspaceEntry({ hash: '', search: '?q=oauth_error' }), false)
})
