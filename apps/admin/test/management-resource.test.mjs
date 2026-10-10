import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { registerSource } from './helpers/onboarding-source.mjs'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://app.example.test/',
  pretendToBeVisual: true,
})
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Node'])
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: dom.window[name],
  })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const hooks = registerSource()
const { useManagementResource } =
  await import('../src/components/management/controls.tsx')
const { saveStoredSession, clearStoredSession, loadStoredSession } =
  await import('../src/features/auth/session.ts')
hooks.deregister()

const account = (userId) => ({
  userId,
  role: 'member',
  roles: ['member'],
  permissions: [],
  authzVersion: 0,
  accessToken: `fixture-${userId}`,
})
const deferred = () => {
  let resolve
  const promise = new Promise((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}

async function render(t, load, options = {}) {
  saveStoredSession(account('account-a'))
  let resource
  function Probe({ options }) {
    resource = useManagementResource('fixture', load, options)
    return h(
      'output',
      null,
      JSON.stringify({
        data: resource.data,
        loading: resource.loading,
        error: resource.error,
        busy: resource.busy,
      }),
    )
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let closed = false
  const update = async (nextOptions = options) => {
    await act(async () => root.render(h(Probe, { options: nextOptions })))
  }
  const close = async () => {
    if (closed) return
    closed = true
    await act(async () => root.unmount())
    container.remove()
    clearStoredSession()
  }
  t.after(close)
  await update()
  return {
    get resource() {
      return resource
    },
    state: () => JSON.parse(container.textContent),
    update,
    close,
  }
}

test('disabled resources do not request data or keep records when disabled', async (t) => {
  let requests = 0
  const view = await render(
    t,
    async () => {
      requests++
      return ['phone']
    },
    { enabled: false },
  )
  assert.equal(requests, 0)
  await view.update({ enabled: true })
  assert.deepEqual(view.state().data, ['phone'])
  assert.equal(requests, 1)
  await view.update({ enabled: false })
  assert.equal(view.state().data, null)
  assert.equal(requests, 1)
})

test('account changes hide old data and ignore responses from the previous account', async (t) => {
  const oldRequest = deferred()
  const newRequest = deferred()
  let requests = 0
  const view = await render(t, () => {
    requests++
    if (loadStoredSession().userId === 'account-b') return newRequest.promise
    return requests === 1
      ? Promise.resolve(['account-a-phone'])
      : oldRequest.promise
  })
  assert.deepEqual(view.state().data, ['account-a-phone'])
  await act(async () => view.resource.reload())
  await act(async () => saveStoredSession(account('account-b')))
  assert.equal(view.state().data, null)
  await act(async () => oldRequest.resolve(['late-account-a-phone']))
  assert.equal(view.state().data, null)
  await act(async () => newRequest.resolve(['account-b-phone']))
  assert.deepEqual(view.state().data, ['account-b-phone'])
})

test('late mutations cannot report success after an account change or unmount', async (t) => {
  const view = await render(t, async () => ['phone'])
  const pending = deferred()
  let mutation
  await act(async () => {
    mutation = view.resource.perform(() => pending.promise)
  })
  await act(async () => saveStoredSession(account('account-b')))
  let success
  await act(async () => {
    pending.resolve()
    success = await mutation
  })
  assert.equal(success, false)
  assert.equal(view.state().busy, false)
  const afterUnmount = deferred()
  await act(async () => {
    mutation = view.resource.perform(() => afterUnmount.promise)
  })
  await view.close()
  afterUnmount.resolve()
  assert.equal(await mutation, false)
})

test('refresh catches newly logged-in clients, skips overlapping requests and cleans up on unmount', async (t) => {
  let tick
  let cleared = false
  t.mock.method(window, 'setInterval', (callback) => {
    tick = callback
    return 123
  })
  t.mock.method(window, 'clearInterval', (timer) => {
    if (timer === 123) cleared = true
  })
  let requests = 0
  let data = []
  let pending
  const view = await render(
    t,
    () => {
      requests++
      return pending?.promise ?? Promise.resolve(data)
    },
    { autoRefreshMs: 15000 },
  )
  data = ['new-phone']
  await act(async () => tick())
  assert.deepEqual(view.state().data, ['new-phone'])
  pending = deferred()
  await act(async () => window.dispatchEvent(new window.Event('focus')))
  const requestsBeforeTick = requests
  await act(async () => tick())
  assert.equal(requests, requestsBeforeTick)
  await act(async () => pending.resolve(['phone-after-focus']))
  assert.deepEqual(view.state().data, ['phone-after-focus'])
  await view.close()
  assert.equal(cleared, true)
  window.dispatchEvent(new window.Event('focus'))
  assert.equal(requests, requestsBeforeTick)
})
