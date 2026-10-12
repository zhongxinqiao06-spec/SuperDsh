import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { JSDOM } from 'jsdom'
import { registerSource } from './helpers/onboarding-source.mjs'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://fixture.example/',
  pretendToBeVisual: true,
})
for (const name of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
])
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: dom.window[name],
  })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const hooks = registerSource()
const { AuthProvider, useAuth } =
  await import('../src/components/auth/auth-context.tsx')
const { authApi } = await import('../src/features/auth/api.ts')
const { rememberAuthFlow } =
  await import('../src/features/auth/continuation.ts')
const { clearStoredSession, saveStoredSession, waitForSessionSignOut } =
  await import('../src/features/auth/session.ts')
hooks.deregister()
const messages = JSON.parse(
  readFileSync(new URL('../messages/en.json', import.meta.url), 'utf8'),
)

async function mount(
  t,
  {
    hash = '#/login',
    permissions = ['users.read'],
    savedFlow,
    query = '',
    restoreSession = false,
  } = {},
) {
  window.localStorage.clear()
  window.sessionStorage.clear()
  // Reset the in-memory logout fence without creating a real browser session.
  saveStoredSession({ userId: 'fixture', accessToken: 'fixture-token' })
  clearStoredSession()
  window.history.replaceState(null, '', `/${query}${hash}`)
  if (savedFlow) rememberAuthFlow(savedFlow, window.sessionStorage)
  const account = {
    userId: 'fixture',
    displayName: 'Fixture account',
    role: permissions.length ? 'admin' : 'member',
    permissions,
    authzVersion: 1,
  }
  const authResponse = { ...account, accessToken: 'fixture-token' }
  if (restoreSession) saveStoredSession(authResponse)
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url === '/api/v2/auth/refresh')
      return new Response(null, { status: 401 })
    assert.equal(url, '/api/v2/auth/logout')
    return new Response(null, { status: 204 })
  })
  t.mock.method(authApi, 'config', async () => ({
    needsBootstrap: false,
    registrationOpen: true,
    emailVerificationRequired: false,
    oauthEnabled: true,
  }))
  t.mock.method(authApi, 'me', async () => account)
  t.mock.method(authApi, 'login', async () => authResponse)
  const finalize = t.mock.method(authApi, 'finalizeOAuth', async () => ({
    auth: authResponse,
  }))
  let auth
  function Probe() {
    auth = useAuth()
    return h(
      'output',
      null,
      `${auth.screen}:${auth.loading}:${auth.isAuthenticated}`,
    )
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let generation = 0
  const render = async () => {
    await act(async () => {
      root.render(
        h(
          NextIntlClientProvider,
          { locale: 'en', messages, timeZone: 'Asia/Shanghai' },
          h(AuthProvider, { key: ++generation }, h(Probe)),
        ),
      )
      await delay(20)
    })
  }
  t.after(async () => {
    await act(async () => root.unmount())
    await waitForSessionSignOut()
    clearStoredSession()
    container.remove()
  })
  await render()
  return {
    get auth() {
      return auth
    },
    finalize,
    remount: render,
    async navigate(screen) {
      await act(async () => {
        auth.navigate(screen)
        await delay(20)
      })
    },
    async login() {
      await act(async () => {
        await auth.login({ email: 'fixture', password: 'fixture-password' })
        await delay(20)
      })
    },
  }
}

test('ordinary login opens the management overview', async (t) => {
  const view = await mount(t)
  assert.equal(view.auth.screen, 'login')
  await view.login()
  assert.equal(window.location.hash, '#/overview')
  assert.equal(view.auth.screen, 'app')
})

for (const hash of ['#/login', '#/register']) {
  test(`restoring an authenticated session from ${hash} opens overview without a login action`, async (t) => {
    const view = await mount(t, { hash, restoreSession: true })
    assert.equal(view.auth.isAuthenticated, true)
    assert.equal(view.auth.screen, 'app')
    assert.equal(window.location.hash, '#/overview')
  })
}

test('restoring an authenticated session consumes a saved console destination', async (t) => {
  const view = await mount(t, {
    hash: '#/login',
    restoreSession: true,
    savedFlow: '#/access/roles',
  })
  assert.equal(view.auth.isAuthenticated, true)
  assert.equal(view.auth.screen, 'app')
  assert.equal(window.location.hash, '#/access/roles')
})

for (const permissions of [['users.read'], []]) {
  test(`management login restores the route without changing ${permissions.length ? 'admin' : 'member'} permissions`, async (t) => {
    const view = await mount(t, { hash: '#/management', permissions })
    assert.equal(view.auth.screen, 'login')
    assert.equal(view.auth.isAuthenticated, false)
    await view.login()
    assert.equal(window.location.hash, '#/management')
    assert.equal(view.auth.screen, 'app')
    assert.deepEqual(view.auth.me.permissions, permissions)
    assert.equal(view.auth.can('users.read'), permissions.length > 0)
  })
}

test('management continuation survives a registration detour and login remount, then is consumed', async (t) => {
  const view = await mount(t, { hash: '#/management' })
  await view.navigate('register')
  await view.navigate('login')
  await view.remount()
  assert.equal(view.auth.screen, 'login')
  await view.login()
  assert.equal(window.location.hash, '#/management')
  await view.navigate('app')
  await view.navigate('login')
  await view.login()
  assert.equal(window.location.hash, '#/overview')
})

test('sign-out clears pending management navigation', async (t) => {
  const view = await mount(t, { hash: '#/management' })
  await view.navigate('login')
  await act(async () => {
    view.auth.signOut()
    await waitForSessionSignOut()
    await delay(20)
  })
  assert.equal(window.location.hash, '#/signed-out')
  await view.navigate('login')
  await view.login()
  assert.equal(window.location.hash, '#/overview')
})

test('saved OAuth continuation retains priority over a management route', async (t) => {
  const savedFlow = '#/desktop-oauth?client_id=superdsh-desktop&state=fixture'
  const view = await mount(t, { hash: '#/management', savedFlow })
  await view.navigate('login')
  await view.login()
  assert.equal(window.location.hash, savedFlow)
  assert.equal(view.auth.screen, 'desktop-oauth')
  await view.navigate('app')
  await view.navigate('login')
  await view.login()
  assert.equal(window.location.hash, '#/overview')
})

test('current OAuth continuation retains priority over saved OAuth context', async (t) => {
  const hash = '#/plugin-oauth?state=current-fixture'
  const view = await mount(t, {
    hash,
    savedFlow: '#/onboarding?flowId=saved-fixture',
  })
  await view.login()
  assert.equal(window.location.hash, hash)
  assert.equal(view.auth.screen, 'plugin-oauth')
})

test('OAuth completion returns to management and clears callback parameters', async (t) => {
  const view = await mount(t, {
    hash: '#/management',
    query: '?oauth_pending=fixture-pending&oauth_status=authenticated',
  })
  assert.equal(view.finalize.mock.callCount(), 1)
  assert.equal(window.location.hash, '#/management')
  assert.equal(window.location.search, '')
  assert.equal(view.auth.screen, 'app')
  assert.equal(view.auth.isAuthenticated, true)
})
