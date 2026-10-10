import assert from 'node:assert/strict'
import test from 'node:test'
import { registerSource } from './helpers/onboarding-source.mjs'

const hooks = registerSource()
const { ApiClient } = await import('../src/lib/api/client.ts')
const {
  saveStoredSession,
  loadStoredSession,
  clearStoredSession,
  refreshSession,
  beginSessionSignOut,
  revokeBrowserSession,
  waitForSessionSignOut,
  discardLegacySession,
} = await import('../src/features/auth/session.ts')
const { canManagePlatform } =
  await import('../src/features/management/permissions.ts')
hooks.deregister()

test('switching accounts waits for the old refresh cookie to be revoked', async () => {
  let finishRevoke
  const revoked = new Promise((resolve) => {
    finishRevoke = resolve
  })
  const signOut = revokeBrowserSession(() => revoked)
  let mayLogin = false
  const loginGate = waitForSessionSignOut().then(() => {
    mayLogin = true
  })
  await Promise.resolve()
  assert.equal(mayLogin, false)
  assert.equal(
    revokeBrowserSession(() => {
      throw new Error('duplicate logout')
    }),
    signOut,
  )
  finishRevoke()
  await loginGate
  assert.equal(mayLogin, true)
})
const response = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
const auth = (accessToken) => ({
  accessToken,
  userId: 'user-1',
  role: 'member',
  permissions: ['devices.read'],
  authzVersion: 4,
})

test('concurrent unauthorized requests share one cookie refresh and retry with the new access token', async () => {
  saveStoredSession(auth('expired'))
  let refreshes = 0
  let retries = 0
  const client = new ApiClient({
    fetcher: async (url, init) => {
      if (String(url).endsWith('/auth/refresh')) {
        refreshes += 1
        assert.equal(init.credentials, 'same-origin')
        assert.equal(new Headers(init.headers).has('authorization'), false)
        await new Promise((resolve) => setTimeout(resolve, 5))
        return response(auth('fresh'))
      }
      if (init.headers.get('authorization') === 'Bearer expired')
        return response({ detail: 'expired' }, 401)
      assert.equal(init.headers.get('authorization'), 'Bearer fresh')
      retries += 1
      return response({ ok: true })
    },
  })
  assert.deepEqual(
    await Promise.all([client.get('/connectors'), client.get('/sessions')]),
    [{ ok: true }, { ok: true }],
  )
  assert.equal(refreshes, 1)
  assert.equal(retries, 2)
  assert.equal(loadStoredSession().authzVersion, 4)
  clearStoredSession()
})

test('a delayed stale 401 reuses a token already refreshed by another request', async () => {
  saveStoredSession(auth('expired'))
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let refreshes = 0
  const client = new ApiClient({
    fetcher: async (url, init) => {
      if (String(url).endsWith('/auth/refresh')) {
        refreshes += 1
        return response(auth('fresh'))
      }
      if (init.headers.get('authorization') === 'Bearer expired') {
        if (String(url).endsWith('/slow')) await gate
        return response({}, 401)
      }
      return response('ok')
    },
  })
  const slow = client.get('/slow')
  assert.equal(await client.get('/fast'), 'ok')
  release()
  assert.equal(await slow, 'ok')
  assert.equal(refreshes, 1)
  clearStoredSession()
})

test('logout fences an in-flight refresh and waits for its cookie response before revocation', async () => {
  saveStoredSession(auth('expired'))
  let finish
  const request = refreshSession(
    '/refresh',
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  let settled = false
  const signingOut = beginSessionSignOut().then(() => {
    settled = true
  })
  assert.equal(loadStoredSession(), null)
  assert.equal(settled, false)
  finish(response(auth('late-token')))
  assert.equal(await request, null)
  await signingOut
  assert.equal(settled, true)
  assert.equal(loadStoredSession(), null)
  let called = false
  assert.equal(
    await refreshSession('/refresh', async () => {
      called = true
      return response(auth('wrong'))
    }),
    null,
  )
  assert.equal(called, false)
})

test('forbidden operations are not retried and do not rotate credentials', async () => {
  saveStoredSession(auth('member'))
  let calls = 0
  const client = new ApiClient({
    fetcher: async () => {
      calls += 1
      return response({ detail: 'permission denied' }, 403)
    },
  })
  await assert.rejects(
    client.get('/admin/users'),
    (error) => error.status === 403,
  )
  assert.equal(calls, 1)
  clearStoredSession()
})

test('legacy persistent credentials are discarded without being loaded', () => {
  const removed = []
  const previous = globalThis.window
  globalThis.window = {
    localStorage: {
      getItem() {
        throw new Error('must never read credentials')
      },
      removeItem(key) {
        removed.push(key)
      },
    },
  }
  try {
    discardLegacySession()
    assert.equal(loadStoredSession(), null)
    assert.deepEqual(removed, ['aa.session.v1'])
  } finally {
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
  }
})

test('platform navigation follows effective permissions, with no role-name bypass', () => {
  assert.equal(canManagePlatform(undefined), false)
  assert.equal(canManagePlatform(['sessions.read', 'devices.read']), false)
  assert.equal(canManagePlatform(['models.manage']), true)
  assert.equal(canManagePlatform(['users.read']), true)
})
