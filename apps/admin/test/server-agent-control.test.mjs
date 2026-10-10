import assert from 'node:assert/strict'
import test from 'node:test'
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
  'Element',
  'Node',
  'getComputedStyle',
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
const { ServerAgentControl } =
  await import('../src/components/server-agent-control.tsx')
const { serverAgentApi } =
  await import('../src/features/dashboard/server-agent.ts')
const { saveStoredSession, clearStoredSession, loadStoredSession } =
  await import('../src/features/auth/session.ts')
hooks.deregister()

const stopped = {
  status: 'stopped',
  connectorId: null,
  runtimeId: null,
  projectId: null,
  error: null,
}
const ready = {
  status: 'running',
  connectorId: 'owned-agent-connector',
  runtimeId: 'dsh',
  projectId: 'owned-server-project',
  error: null,
}
const account = (userId) => ({
  userId,
  accessToken: `synthetic-${userId}`,
  role: 'member',
  roles: ['member'],
  permissions: [],
  authzVersion: 1,
})
const deferred = () => {
  let resolve
  const promise = new Promise((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}

async function mount(
  t,
  {
    load = async () => ({ agent: stopped }),
    prepare = async () => ({ agent: ready }),
    locale = 'en',
  } = {},
) {
  saveStoredSession(account('first-user'))
  let tick
  t.mock.method(window, 'setInterval', (callback) => {
    tick = callback
    return 12
  })
  t.mock.method(window, 'clearInterval', () => {})
  const get = t.mock.method(serverAgentApi, 'get', load)
  const post = t.mock.method(serverAgentApi, 'prepare', prepare)
  const received = []
  let available = 0
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () =>
    root.render(
      h(
        NextIntlClientProvider,
        { locale, messages: {} },
        h(ServerAgentControl, {
          onReady: (agent) => received.push(agent),
          onAvailable: () => available++,
        }),
      ),
    ),
  )
  t.after(async () => {
    await act(async () => root.unmount())
    container.remove()
    clearStoredSession()
  })
  return {
    container,
    get,
    post,
    received,
    get available() {
      return available
    },
    refresh: async () => act(async () => tick()),
  }
}

async function click(view, label) {
  const button = [...view.container.querySelectorAll('button')].find(
    (item) => item.textContent === label,
  )
  assert.ok(button, `Missing button ${label}`)
  assert.equal(button.disabled, false)
  await act(async () => button.click())
}

test('login preparation is observed without creating a second target or taking over the current conversation', async (t) => {
  let agent = stopped
  const view = await mount(t, {
    load: async () => ({ agent }),
  })
  assert.match(view.container.textContent, /No computer required/)
  assert.match(view.container.textContent, /Preparing automatically/)
  assert.equal(view.container.querySelectorAll('button').length, 0)
  assert.equal(view.post.mock.callCount(), 0)
  agent = { ...stopped, status: 'starting' }
  await view.refresh()
  assert.deepEqual(view.received, [])
  agent = { ...ready, projectId: null }
  await view.refresh()
  assert.deepEqual(view.received, [])
  assert.equal(view.available, 0)
  agent = ready
  await view.refresh()
  assert.equal(view.available, 1)
  assert.deepEqual(view.received, [])
  assert.match(view.container.textContent, /Ready/)
  await view.refresh()
  assert.equal(view.available, 1)
  assert.equal(view.post.mock.callCount(), 0)
  await click(view, 'Use Server Agent')
  assert.deepEqual(view.received, [ready])
  assert.equal(view.received.length, 1)
})

test('a provision failure retries only on request and success does not replace the selected target', async (t) => {
  let failing = true
  let agent = {
    ...stopped,
    status: 'error',
    error: 'Isolated worker image unavailable',
  }
  const view = await mount(t, {
    load: async () => ({ agent }),
    prepare: async () => {
      if (failing) throw new Error('Isolated worker image unavailable')
      agent = ready
      return { agent }
    },
  })
  await view.refresh()
  assert.equal(view.post.mock.callCount(), 0)
  await click(view, 'Retry')
  assert.match(view.container.textContent, /worker image unavailable/)
  assert.equal(view.received.length, 0)
  failing = false
  await click(view, 'Retry')
  assert.deepEqual(view.received, [])
  assert.equal(view.available, 1)
  await click(view, 'Use Server Agent')
  assert.equal(view.post.mock.callCount(), 2)
  assert.deepEqual(view.received, [ready])
})

test('a pending prepare from the previous account cannot select its target for the new account', async (t) => {
  const pending = deferred()
  let first = { ...stopped, status: 'error', error: 'Provision failed' }
  const view = await mount(t, {
    load: async () => ({
      agent: loadStoredSession().userId === 'first-user' ? first : stopped,
    }),
    prepare: () => pending.promise,
  })
  await click(view, 'Retry')
  await act(async () => saveStoredSession(account('second-user')))
  await act(async () => {
    first = ready
    pending.resolve({ agent: ready })
  })
  await view.refresh()
  assert.deepEqual(view.received, [])
  assert.equal(view.available, 0)
  assert.match(view.container.textContent, /Preparing automatically/)
  assert.doesNotMatch(view.container.textContent, /Use Server Agent/)
})

test('a missing runtime is diagnosed in Chinese instead of pretending preparation succeeded', async (t) => {
  const view = await mount(t, {
    locale: 'zh-CN',
    load: async () => ({
      agent: {
        ...stopped,
        error: 'server Agent supervisor is not configured',
      },
    }),
  })
  assert.match(view.container.textContent, /无需连接电脑/)
  assert.match(view.container.textContent, /服务端未配置/)
  assert.match(view.container.textContent, /请先配置服务端 Agent 运行环境/)
  assert.doesNotMatch(view.container.textContent, /自动准备中|准备并使用/)
  await view.refresh()
  assert.equal(view.post.mock.callCount(), 0)
})

test('a read failure retries the status request without provisioning another runtime', async (t) => {
  let failing = true
  const view = await mount(t, {
    load: async () => {
      if (failing) throw new Error('Network unavailable')
      return { agent: ready }
    },
  })
  assert.match(view.container.textContent, /Status unavailable/)
  failing = false
  await click(view, 'Retry')
  assert.equal(view.post.mock.callCount(), 0)
  assert.equal(view.available, 1)
  assert.deepEqual(view.received, [])
})

test('logout removes the control and ignores a delayed status response', async (t) => {
  const pending = deferred()
  const view = await mount(t, { load: () => pending.promise })
  await act(async () => clearStoredSession())
  await act(async () => pending.resolve({ agent: ready }))
  assert.equal(view.container.textContent, '')
  assert.equal(view.available, 0)
  assert.deepEqual(view.received, [])
})
