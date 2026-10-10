import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { registerSource } from './helpers/onboarding-source.mjs'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://app.example.test/',
  pretendToBeVisual: true,
})
for (const name of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'Element',
  'Node',
  'NodeFilter',
  'CustomEvent',
  'MutationObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
]) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: dom.window[name],
  })
}
window.matchMedia = () => ({
  matches: true,
  addEventListener() {},
  removeEventListener() {},
})
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const hooks = registerSource()
const { AuthProvider } = await import('../src/components/auth/auth-context.tsx')
const { LoginScreen } = await import('../src/components/auth/login-screen.tsx')
const { authApi } = await import('../src/features/auth/api.ts')
const { clearStoredSession, loadStoredSession } =
  await import('../src/features/auth/session.ts')
hooks.deregister()

async function render(t, locale = 'en') {
  window.localStorage.clear()
  clearStoredSession()
  window.sessionStorage.clear()
  window.history.replaceState({}, '', '/#/login')
  t.mock.method(authApi, 'config', async () => ({
    needsBootstrap: false,
    registrationOpen: true,
    emailVerificationRequired: false,
    oauthEnabled: false,
  }))
  const account = {
    userId: 'stable-account-id',
    email: 'member@example.com',
    displayName: 'Member',
    role: 'admin',
  }
  t.mock.method(authApi, 'me', async () => account)
  const login = t.mock.method(authApi, 'login', async () => ({
    ...account,
    accessToken: 'synthetic-session',
  }))
  const messages = JSON.parse(
    readFileSync(
      new URL(`../messages/${locale}.json`, import.meta.url),
      'utf8',
    ),
  )
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      h(
        NextIntlClientProvider,
        { locale, messages, timeZone: 'Asia/Shanghai' },
        h(AuthProvider, null, h(LoginScreen)),
      ),
    )
  })
  t.after(async () => {
    await act(async () => root.unmount())
    container.remove()
  })
  return {
    container,
    messages,
    login,
    identity: container.querySelector('#login-email'),
    password: container.querySelector('#login-password'),
    submit: [...container.querySelectorAll('button')].find(
      (button) => button.textContent === messages.auth.login.submitWithEnter,
    ),
  }
}

async function fill(input, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    ).set.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

async function pressEnter(input) {
  await act(async () => {
    input.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    )
  })
}

for (const locale of ['en', 'zh-CN']) {
  for (const identity of ['admin', 'member@example.com']) {
    test(`${locale} login accepts ${identity} and keeps the returned stable account identity`, async (t) => {
      const view = await render(t, locale)
      assert.equal(view.identity.type, 'text')
      assert.equal(view.identity.autocomplete, 'username')
      assert.equal(
        view.identity.labels[0].textContent,
        view.messages.auth.login.identityLabel,
      )
      assert.equal(
        view.identity.placeholder,
        view.messages.auth.login.identityPlaceholder,
      )
      await fill(view.identity, identity)
      await fill(view.password, 'synthetic password')
      assert.equal(view.submit.disabled, false)
      if (identity === 'admin') await pressEnter(view.password)
      else await act(async () => view.submit.click())
      assert.deepEqual(view.login.mock.calls[0].arguments, [
        { email: identity, password: 'synthetic password' },
      ])
      assert.equal(view.login.mock.callCount(), 1)
      assert.equal(window.localStorage.getItem('aa.session.v1'), null)
      assert.deepEqual(loadStoredSession(), {
        accessToken: 'synthetic-session',
        userId: 'stable-account-id',
        role: 'admin',
        roles: [],
        permissions: [],
        authzVersion: 0,
      })
    })
  }
}

test('login rejects empty identities and missing passwords through click and Enter', async (t) => {
  const view = await render(t)
  for (const identity of ['', '   ']) {
    await fill(view.identity, identity)
    await fill(view.password, 'synthetic password')
    assert.equal(view.submit.disabled, true)
    await act(async () => view.submit.click())
    await pressEnter(view.password)
  }
  await fill(view.identity, 'admin')
  await fill(view.password, '')
  assert.equal(view.submit.disabled, true)
  await pressEnter(view.password)
  assert.equal(view.login.mock.callCount(), 0)
})
