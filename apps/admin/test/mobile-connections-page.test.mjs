import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
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
  'Element',
  'Node',
  'NodeFilter',
  'Event',
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
const { MobileConnectionsPage } =
  await import('../src/components/pages/mobile-connections-page.tsx')
const { authApi } = await import('../src/features/auth/api.ts')
const { managementApi } = await import('../src/features/management/api.ts')
const { saveStoredSession, clearStoredSession, loadStoredSession } =
  await import('../src/features/auth/session.ts')
hooks.deregister()

const account = {
  userId: 'user1',
  displayName: '测试用户',
  role: 'admin',
  roles: ['admin'],
  permissions: ['devices.read', 'sessions.read'],
  authzVersion: 1,
}
function loginSession(id, clientName, extra = {}) {
  return {
    id,
    clientName,
    createdAt: '2026-01-01T00:00:00Z',
    lastSeenAt: '2026-01-02T00:00:00Z',
    expiresAt: '2099-01-01T00:00:00Z',
    current: false,
    ...extra,
  }
}

async function render(
  t,
  {
    locale = 'zh-CN',
    sessions = [loginSession('android-login', 'SuperDsh Android')],
    load = async () => ({ sessions }),
  } = {},
) {
  window.localStorage.clear()
  window.sessionStorage.clear()
  clearStoredSession()
  window.history.replaceState({}, '', '/#/mobile-connections')
  saveStoredSession({ ...account, accessToken: 'synthetic-test-session' })
  t.mock.method(authApi, 'config', async () => ({
    needsBootstrap: false,
    registrationOpen: true,
  }))
  t.mock.method(authApi, 'me', async () => account)
  const loader = t.mock.method(managementApi, 'sessions', load)
  const qr = t.mock.method(authApi, 'createMobileLoginQr', async () => {
    throw new Error('QR creation must be explicitly requested')
  })
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected network request in headless component test')
  })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () =>
    root.render(
      h(
        NextIntlClientProvider,
        {
          locale,
          messages: JSON.parse(
            readFileSync(
              new URL(`../messages/${locale}.json`, import.meta.url),
              'utf8',
            ),
          ),
          timeZone: 'Asia/Shanghai',
        },
        h(AuthProvider, null, h(MobileConnectionsPage)),
      ),
    ),
  )
  t.after(async () => {
    await act(async () => root.unmount())
    container.remove()
    clearStoredSession()
  })
  return { container, loader, qr }
}

async function until(check) {
  for (let count = 0; count < 100; count++) {
    if (check()) return
    await act(async () => {
      await delay(15)
    })
  }
  assert.fail('Expected UI state did not arrive: ' + document.body.textContent)
}

function button(container, label) {
  const found = [...container.querySelectorAll('button')].find(
    (item) => item.textContent === label,
  )
  assert.ok(found, `Button not found: ${label}`)
  return found
}

function rows(container) {
  return [...container.querySelectorAll('[data-mobile-login-session]')]
}

test('existing mobile sign-ins appear without QR onboarding or creating a connector', async (t) => {
  const { container, loader, qr } = await render(t, {
    sessions: [
      loginSession('password-phone', 'SuperDsh Android'),
      loginSession('oauth-phone', 'agents-anywhere-mobile'),
      loginSession('qr-phone', 'Mobile'),
      loginSession('browser-login', 'SuperDsh Admin'),
      loginSession('desktop-login', 'SuperDsh Desktop'),
      loginSession('unknown-login', 'Android custom client'),
    ],
  })
  await until(() => rows(container).length === 3)
  assert.equal(container.querySelector('h1').textContent, '手机登录会话')
  assert.match(container.textContent, /无需扫码/)
  assert.match(container.textContent, /最近使用时间不代表实时在线/)
  assert.equal(container.querySelector('[data-slide="phone"]'), null)
  assert.equal(
    container.querySelector('img[src="/images/onboarding/phone.webp"]'),
    null,
  )
  assert.equal(document.querySelector('[role="dialog"]'), null)
  assert.equal(loader.mock.callCount(), 1)
  assert.equal(qr.mock.callCount(), 0)
  assert.deepEqual(
    rows(container).map((row) => row.dataset.mobileLoginSession),
    ['password-phone', 'oauth-phone', 'qr-phone'],
  )
  assert.doesNotMatch(
    container.textContent,
    /SuperDsh Admin|SuperDsh Desktop|Android custom client/,
  )
})

test('refresh and window focus load new sign-ins for the current account', async (t) => {
  let sessions = [loginSession('first-phone', 'SuperDsh Android')]
  const { container, loader } = await render(t, {
    load: async () => ({ sessions }),
  })
  await until(() => rows(container).length === 1)
  sessions = [...sessions, loginSession('second-phone', 'Mobile')]
  await act(async () => button(container, '刷新').click())
  await until(() => rows(container).length === 2)
  sessions = [
    ...sessions,
    loginSession('third-phone', 'agents-anywhere-mobile'),
  ]
  await act(async () => window.dispatchEvent(new Event('focus')))
  await until(() => rows(container).length === 3)
  assert.equal(loader.mock.callCount(), 3)
})

test('failed loading is an error with retry, never a successful empty list', async (t) => {
  let failing = true
  const { container } = await render(t, {
    load: async () => {
      if (failing) throw new Error('Session service unavailable (503)')
      return { sessions: [loginSession('recovered-phone', 'SuperDsh Android')] }
    },
  })
  await until(() => container.querySelector('[role="alert"]'))
  assert.match(container.textContent, /无法加载手机登录会话/)
  assert.match(container.textContent, /503/)
  assert.doesNotMatch(container.textContent, /暂无有效的手机登录会话/)
  failing = false
  await act(async () => button(container, '重试').click())
  await until(() => rows(container).length === 1)
  assert.equal(container.querySelector('[role="alert"]'), null)
})

test('a successful empty response distinguishes no mobile sessions from account failure', async (t) => {
  const { container } = await render(t, {
    sessions: [loginSession('web-only', 'Browser')],
  })
  await until(() => container.textContent.includes('暂无有效的手机登录会话'))
  assert.equal(container.querySelector('[role="alert"]'), null)
  assert.match(container.textContent, /相同服务地址登录/)
  assert.ok(button(container, '添加另一部手机 / 扫码登录'))
})

test('pending loading does not claim that the account has no mobile sessions', async (t) => {
  let resolve
  const pending = new Promise((finish) => {
    resolve = finish
  })
  const { container } = await render(t, { load: () => pending })
  await until(() => container.querySelector('[role="status"]'))
  assert.match(container.textContent, /正在加载手机登录会话/)
  assert.doesNotMatch(container.textContent, /暂无有效的手机登录会话/)
  assert.equal(button(container, '刷新').disabled, true)
  await act(async () => resolve({ sessions: [] }))
  await until(() => container.textContent.includes('暂无有效的手机登录会话'))
})

test('revocation requires confirmation and only revokes the selected login session', async (t) => {
  let sessions = [loginSession('my-phone-login', 'SuperDsh Android')]
  const revoke = t.mock.method(managementApi, 'revokeSession', async (id) => {
    sessions = sessions.filter((item) => item.id !== id)
  })
  const confirmation = t.mock.method(window, 'confirm', () => {
    throw new Error('Use the product confirmation dialog')
  })
  const { container } = await render(t, { load: async () => ({ sessions }) })
  await until(() => rows(container).length === 1)
  await act(async () => button(container, '撤销登录').click())
  assert.equal(revoke.mock.callCount(), 0)
  assert.ok(document.querySelector('[role="dialog"]'))
  await act(async () => button(document.body, '取消').click())
  assert.equal(document.querySelector('[role="dialog"]'), null)
  await act(async () => button(container, '撤销登录').click())
  await act(async () => button(document.body, '确认撤销').click())
  await until(() => container.textContent.includes('暂无有效的手机登录会话'))
  assert.deepEqual(revoke.mock.calls[0].arguments, ['my-phone-login'])
  assert.equal(revoke.mock.callCount(), 1)
  assert.equal(loadStoredSession().userId, 'user1')
  assert.equal(confirmation.mock.callCount(), 0)
})

test('mobile login pages include only mobile records and clamp after the last record is revoked', async (t) => {
  let sessions = [
    loginSession('web', 'Browser'),
    ...Array.from({ length: 21 }, (_, i) =>
      loginSession(`phone-${i}`, 'SuperDsh Android'),
    ),
  ]
  t.mock.method(managementApi, 'revokeSession', async (id) => {
    sessions = sessions.filter((item) => item.id !== id)
  })
  const { container } = await render(t, { load: async () => ({ sessions }) })
  await until(() => rows(container).length === 10)
  assert.match(container.textContent, /共 21 条/)
  await act(async () => button(container, '下一页').click())
  assert.equal(rows(container).length, 10)
  await act(async () => button(container, '下一页').click())
  assert.equal(rows(container).length, 1)
  assert.equal(rows(container)[0].dataset.mobileLoginSession, 'phone-20')
  await act(async () => button(container, '撤销登录').click())
  await act(async () => button(document.body, '确认撤销').click())
  await until(() => rows(container).length === 10)
  assert.match(container.textContent, /第 2 \/ 2 页/)
})

test('QR sign-in remains an optional dialog action', async (t) => {
  const { container, qr } = await render(t)
  await until(() => rows(container).length === 1)
  await act(async () => button(container, '添加另一部手机 / 扫码登录').click())
  await until(() => document.querySelector('[role="dialog"]'))
  const dialog = document.querySelector('[role="dialog"]')
  assert.match(dialog.textContent, /下载移动端 App/)
  assert.match(dialog.textContent, /直接使用同一账号登录/)
  assert.equal(qr.mock.callCount(), 0)
})

test('the mobile page and optional action use English translations', async (t) => {
  const { container } = await render(t, { locale: 'en' })
  await until(() => rows(container).length === 1)
  assert.equal(
    container.querySelector('h1').textContent,
    'Mobile sign-in sessions',
  )
  assert.match(container.textContent, /No QR scan is required/)
  assert.ok(button(container, 'Add another phone / Scan to sign in'))
  assert.ok(button(container, 'Revoke sign-in'))
})

test('the sidebar visibility toggle remains available and persists its setting', async (t) => {
  const { container } = await render(t)
  await until(() => rows(container).length === 1)
  await act(async () => button(container, '在侧边栏隐藏').click())
  assert.equal(
    window.localStorage.getItem('aa-mobile-connections-sidebar-visible-v1'),
    'false',
  )
  assert.ok(button(container, '在侧边栏显示'))
  await act(async () => button(container, '在侧边栏显示').click())
  assert.equal(
    window.localStorage.getItem('aa-mobile-connections-sidebar-visible-v1'),
    'true',
  )
})
