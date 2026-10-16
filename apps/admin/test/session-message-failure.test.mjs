import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { registerSource } from './helpers/onboarding-source.mjs'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://fixture.example/#/workspace',
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
  'DocumentFragment',
  'Node',
  'NodeFilter',
  'Event',
  'CustomEvent',
  'MutationObserver',
  'getComputedStyle',
]) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: dom.window[name],
  })
}
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const hooks = registerSource()
const { TimelineEntry } =
  await import('../src/components/session/session-timeline-entry.tsx')
const { FailedSessionRecovery } =
  await import('../src/components/session/failed-session-recovery.tsx')
const { mergeTimelineItems, hasUnconfirmedMessage, restoreRejectedSendState } =
  await import('../src/components/session/optimistic-timeline.ts')
test.after(() => hooks.deregister())
const messages = JSON.parse(
  readFileSync(new URL('../messages/zh-CN.json', import.meta.url), 'utf8'),
)
let root
let container
test.afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container?.remove()
})

async function renderMessage(status, error, deliveryOutcome) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      h(
        NextIntlClientProvider,
        { locale: 'zh-CN', messages },
        h(TimelineEntry, {
          token: 'fixture-token',
          session: { id: 'fixture-session', runtime: 'dsh' },
          item: {
            id: 'optimistic-message:fixture',
            type: 'message',
            role: 'user',
            status,
            content: { text: '你好', error, deliveryOutcome },
            source: {},
          },
          resolvingNoticeId: null,
          resolvingActionId: null,
          onRespondInteraction() {},
        }),
      ),
    ),
  )
}

test('failed message shows the actual failure inline after the toast disappears', async () => {
  const diagnostic = 'The selected model is no longer available'
  await renderMessage('failed', diagnostic)
  const alert = container.querySelector('[role="alert"]')
  assert.ok(alert)
  assert.ok(alert.textContent.includes(messages.dashboard.session.sendFailed))
  assert.ok(alert.textContent.includes(diagnostic))
  assert.ok(!alert.textContent.includes('failed'))
})

test('failed message without a diagnostic still displays a translated error', async () => {
  await renderMessage('failed')
  const alert = container.querySelector('[role="alert"]')
  assert.equal(alert.textContent, messages.dashboard.session.sendFailed)
})

test('pending messages do not render a failure from stale metadata', async () => {
  await renderMessage('pending', 'Old failure')
  assert.equal(container.querySelector('[role="alert"]'), null)
})

test('a network failure is presented as an unconfirmed message rather than a definite rejection', async () => {
  await renderMessage('failed', 'Connection interrupted', 'unknown')
  const alert = container.querySelector('[role="alert"]')
  assert.ok(alert.textContent.includes('发送结果尚未确认'))
  assert.ok(alert.textContent.includes('不要重复发送'))
  assert.ok(!alert.textContent.includes(messages.dashboard.session.sendFailed))
})

async function renderRecovery(onRestore, options = {}) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      h(
        NextIntlClientProvider,
        { locale: 'zh-CN', messages },
        h(FailedSessionRecovery, { onRestore, ...options }),
      ),
    ),
  )
}

test('recovering a failed creation only restores after an explicit click', async () => {
  const calls = []
  await renderRecovery((overwrite) => {
    calls.push(overwrite)
    return 'restored'
  })
  assert.deepEqual(calls, [])
  assert.ok(container.textContent.includes('手动发送'))
  await act(async () => container.querySelector('button').click())
  assert.deepEqual(calls, [false])
  assert.equal(document.querySelector('[role="dialog"]'), null)
})

test('a competing draft requires confirmation and cancellation leaves it untouched', async () => {
  const calls = []
  await renderRecovery((overwrite) => {
    calls.push(overwrite)
    return overwrite ? 'restored' : 'conflict'
  })
  await act(async () => container.querySelector('button').click())
  let dialog = document.querySelector('[role="dialog"]')
  assert.ok(dialog)
  assert.ok(dialog.textContent.includes('不会自动发送'))
  await act(async () =>
    [...dialog.querySelectorAll('button')]
      .find((button) => button.textContent === '取消')
      .click(),
  )
  assert.deepEqual(calls, [false])
  assert.equal(document.querySelector('[role="dialog"]'), null)
  await act(async () => container.querySelector('button').click())
  dialog = document.querySelector('[role="dialog"]')
  await act(async () =>
    [...dialog.querySelectorAll('button')]
      .find((button) => button.textContent === '替换并继续编辑')
      .click(),
  )
  assert.deepEqual(calls, [false, false, true])
  assert.equal(document.querySelector('[role="dialog"]'), null)
})

test('an unknown create outcome only offers checking the list, never restoring to a second send', async () => {
  let checks = 0
  await renderRecovery(
    () => {
      assert.fail('an uncertain request must not restore a fresh send')
    },
    {
      uncertain: true,
      onCheck: () => {
        checks += 1
      },
    },
  )
  assert.ok(container.textContent.includes('任务可能已经提交'))
  assert.ok(!container.textContent.includes('返回新会话编辑'))
  assert.equal(checks, 0)
  await act(async () => container.querySelector('button').click())
  assert.equal(checks, 1)
})

test('an uncertain message with a real session ID offers refreshing that session', async () => {
  let checks = 0
  await renderRecovery(() => assert.fail('must not restore to a new send'), {
    uncertain: true,
    knownSession: true,
    onCheck: () => {
      checks += 1
    },
  })
  assert.equal(container.querySelector('button').textContent, '刷新当前会话')
  await act(async () => container.querySelector('button').click())
  assert.equal(checks, 1)
})

test('a late accepted projection replaces its uncertain optimistic message without duplication', () => {
  const optimistic = {
    id: 'optimistic-message:uncertain',
    sessionId: 'real-session',
    type: 'message',
    role: 'user',
    status: 'failed',
    content: {
      text: '你好',
      error: 'Outcome unknown',
      deliveryOutcome: 'unknown',
    },
    source: { clientMessageId: 'uncertain', optimistic: true },
    orderSeq: 1,
    updatedSeq: 1,
  }
  const accepted = {
    ...optimistic,
    id: 'native-message',
    status: 'done',
    content: { text: '你好' },
    source: { clientMessageId: 'uncertain', runtime: 'dsh' },
    revision: 1,
    updatedSeq: 2,
  }
  assert.equal(hasUnconfirmedMessage([optimistic]), true)
  const reconciled = mergeTimelineItems([optimistic], [accepted])
  assert.deepEqual(reconciled, [accepted])
  assert.equal(hasUnconfirmedMessage(reconciled), false)
})

test('a rejected send rolls back only its own untouched provisional state', () => {
  const previous = { status: 'running', updatedSeq: 8 }
  const optimistic = { status: 'waiting', updatedSeq: 8 }
  assert.equal(
    restoreRejectedSendState(
      optimistic,
      optimistic,
      previous,
      8,
      8,
      'rejected',
    ),
    previous,
  )
  for (const authoritative of [
    { status: 'waiting', updatedSeq: 9 },
    { status: 'waiting_approval', updatedSeq: 9 },
    { status: 'running', updatedSeq: 9 },
    { status: 'idle', updatedSeq: 9 },
  ]) {
    assert.equal(
      restoreRejectedSendState(
        authoritative,
        optimistic,
        previous,
        9,
        8,
        'rejected',
      ),
      authoritative,
    )
  }
  assert.equal(
    restoreRejectedSendState(
      optimistic,
      optimistic,
      previous,
      9,
      8,
      'rejected',
    ),
    optimistic,
  )
  assert.equal(
    restoreRejectedSendState(optimistic, optimistic, previous, 8, 8, 'unknown'),
    optimistic,
  )
})
