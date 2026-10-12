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
  'HTMLButtonElement',
  'HTMLFormElement',
  'Element',
  'Node',
  'NodeFilter',
  'Event',
  'CustomEvent',
  'MutationObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
])
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: dom.window[name],
  })
window.matchMedia = () => ({
  matches: true,
  addEventListener() {},
  removeEventListener() {},
})
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const hooks = registerSource()
const { AuthProvider } = await import('../src/components/auth/auth-context.tsx')
const { AccountProfileCard } =
  await import('../src/components/pages/account-profile-card.tsx')
const { ServiceEmailCard } =
  await import('../src/components/pages/service-email-card.tsx')
const { ServicePage } = await import('../src/components/pages/service-page.tsx')
const { SecurityCard } =
  await import('../src/components/management/security-card.tsx')
const { authApi } = await import('../src/features/auth/api.ts')
const { managementApi } = await import('../src/features/management/api.ts')
const { announcementsApi } =
  await import('../src/features/announcements/api.ts')
const { clearStoredSession, saveStoredSession } =
  await import('../src/features/auth/session.ts')
hooks.deregister()

const account = {
  userId: 'settings-user',
  username: 'settings-user',
  displayName: 'User',
  email: null,
  emailVerified: false,
  role: 'admin',
  roles: ['admin'],
  permissions: ['settings.manage'],
  authzVersion: 1,
}
const messages = JSON.parse(
  readFileSync(new URL('../messages/zh-CN.json', import.meta.url), 'utf8'),
)
async function render(t, element) {
  window.localStorage.clear()
  clearStoredSession()
  saveStoredSession({ ...account, accessToken: 'test-token' })
  t.mock.method(authApi, 'config', async () => ({
    needsBootstrap: false,
    registrationOpen: true,
    emailVerificationRequired: false,
  }))
  t.mock.method(authApi, 'me', async () => account)
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected network request')
  })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () =>
    root.render(
      h(
        NextIntlClientProvider,
        { locale: 'zh-CN', messages, timeZone: 'Asia/Shanghai' },
        h(AuthProvider, null, element),
      ),
    ),
  )
  t.after(async () => {
    await act(async () => root.unmount())
    container.remove()
    clearStoredSession()
  })
  return container
}
function button(text, scope = document.body) {
  const found = [...scope.querySelectorAll('button')].find(
    (item) => item.textContent === text,
  )
  assert.ok(found, `Missing button: ${text}`)
  return found
}
async function click(element) {
  await act(async () => element.click())
}
async function fill(input, value) {
  assert.ok(input)
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    ).set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

test('profile remains a summary until editing; failed saves retain the draft and retry closes the dialog', async (t) => {
  let fails = true
  const update = t.mock.method(
    authApi,
    'updateProfile',
    async (_token, displayName) => {
      if (fails) throw new Error('Save unavailable')
      return { ...account, displayName }
    },
  )
  const changed = []
  await render(
    t,
    h(AccountProfileCard, {
      me: account,
      token: 'test-token',
      onMeChange: (me) => changed.push(me),
    }),
  )
  assert.equal(document.querySelector('input'), null)
  await click(button('修改昵称'))
  await fill(document.querySelector('[role="dialog"] input'), 'Changed name')
  await click(button('保存'))
  assert.match(
    document.querySelector('[role="dialog"] [role="alert"]').textContent,
    /Save unavailable/,
  )
  assert.equal(
    document.querySelector('[role="dialog"] input').value,
    'Changed name',
  )
  fails = false
  await click(button('保存'))
  assert.equal(document.querySelector('[role="dialog"]'), null)
  assert.equal(update.mock.callCount(), 2)
  assert.equal(changed[0].displayName, 'Changed name')
})

test('email provider edits are isolated in a dialog and omitted keys preserve stored credentials', async (t) => {
  const settings = {
    enabled: false,
    fromAddress: 'test@example.test',
    apiKeyConfigured: true,
  }
  const update = t.mock.method(
    authApi,
    'updateSettings',
    async (_token, body) => ({ email: { ...settings, ...body.email } }),
  )
  const saved = []
  await render(
    t,
    h(ServiceEmailCard, {
      settings,
      token: 'test-token',
      isAdmin: true,
      onSaved: (value) => saved.push(value),
    }),
  )
  assert.equal(document.querySelector('input'), null)
  await click(button('编辑配置'))
  await fill(document.querySelector('#email-from'), 'changed@example.test')
  await click(button('保存邮箱设置'))
  assert.equal(document.querySelector('[role="dialog"]'), null)
  assert.deepEqual(update.mock.calls[0].arguments[1], {
    email: { enabled: false, fromAddress: 'changed@example.test' },
  })
  assert.equal(saved.length, 1)
})

test('sign-in history paginates server results and revocation uses a cancellable product dialog', async (t) => {
  const load = t.mock.method(
    managementApi,
    'sessions',
    async (page, _search, pageSize) => ({
      total: 26,
      page,
      pageSize,
      sessions: [
        { id: `sign-in-${page}`, clientName: `Device ${page}`, current: false },
      ],
    }),
  )
  const revoke = t.mock.method(managementApi, 'revokeSession', async () => {})
  const browserConfirm = t.mock.method(window, 'confirm', () => {
    throw new Error('Browser confirmation must not be used')
  })
  await render(t, h(SecurityCard))
  assert.deepEqual(load.mock.calls[0].arguments, [1, '', 25])
  await click(button('下一页'))
  assert.deepEqual(load.mock.calls.at(-1).arguments, [2, '', 25])
  assert.match(document.body.textContent, /Device 2/)
  await click(button('撤销'))
  await click(button('取消'))
  assert.equal(revoke.mock.callCount(), 0)
  await click(button('撤销'))
  await click(button('确认'))
  assert.deepEqual(revoke.mock.calls[0].arguments, ['sign-in-2'])
  assert.equal(browserConfirm.mock.callCount(), 0)
})

test('service registration controls only persist on modal save, and cancel discards changes', async (t) => {
  const settings = {
    registrationOpen: false,
    oauthRegistrationOpen: false,
    oauth: null,
    email: { enabled: false, fromAddress: '', apiKeyConfigured: false },
  }
  t.mock.method(authApi, 'getSettings', async () => settings)
  t.mock.method(authApi, 'getServiceInfo', async () => ({
    endpoint: 'http://localhost',
    database: 'sqlite',
    version: 'test',
    uptimeSeconds: 1,
    startedAt: '',
  }))
  t.mock.method(announcementsApi, 'settings', async () => ({
    enabled: false,
    markdown: '',
    publishedAt: null,
  }))
  const update = t.mock.method(
    authApi,
    'updateSettings',
    async (_token, body) => ({ ...settings, ...body }),
  )
  await render(t, h(ServicePage))
  assert.equal(document.querySelector('[role="switch"]'), null)
  await click(button('编辑配置'))
  await click(document.querySelector('[role="dialog"] [role="switch"]'))
  assert.equal(update.mock.callCount(), 0)
  await click(button('取消'))
  await click(button('编辑配置'))
  assert.equal(
    document
      .querySelector('[role="dialog"] [role="switch"]')
      .getAttribute('aria-checked'),
    'false',
  )
  await click(document.querySelector('[role="dialog"] [role="switch"]'))
  await click(button('保存'))
  assert.equal(document.querySelector('[role="dialog"]'), null)
  assert.deepEqual(update.mock.calls[0].arguments[1], {
    registrationOpen: true,
    oauthRegistrationOpen: false,
  })
})
