import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { JSDOM } from 'jsdom'
import { registerSource } from './helpers/onboarding-source.mjs'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://fixture.example/#/workspace/session/real-session',
  pretendToBeVisual: true,
})
for (const name of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLButtonElement',
  'HTMLTextAreaElement',
  'HTMLFormElement',
  'Element',
  'DocumentFragment',
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
  matches: false,
  addEventListener() {},
  removeEventListener() {},
})
HTMLElement.prototype.scrollTo = function ({ top }) {
  this.scrollTop = top ?? 0
}
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const sockets = []
globalThis.WebSocket = class {
  constructor() {
    sockets.push(this)
  }
  close() {
    this.closed = true
  }
}
const { createElement: h, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const source = registerSource()
const overrides = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/components/workspace-context.tsx')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export const useWorkspace = () => globalThis.streamWorkspace',
      }
    }
    return nextLoad(url, context)
  },
})
const { SessionDetail } = await import('../src/components/session-detail.tsx')
const { dashboardApi } = await import('../src/features/dashboard/api.ts')
const { saveStoredSession, clearStoredSession } =
  await import('../src/features/auth/session.ts')
const { parseProtocolEvent } =
  await import('../src/components/session/protocol-event.ts')
test.after(() => {
  overrides.deregister()
  source.deregister()
})
const messages = JSON.parse(
  readFileSync(new URL('../messages/zh-CN.json', import.meta.url), 'utf8'),
)
const now = '2026-10-15T12:50:11Z'
const session = {
  id: 'real-session',
  connectorId: 'server-agent',
  projectId: 'project',
  runtime: 'dsh',
  runtimeId: 'dsh',
  runtimeType: 'dsh',
  runtimeName: 'DSH',
  externalSessionId: 'native-session',
  title: '中文问候开场对话',
  cwd: '/fixture/workspace',
  status: 'running',
  connectorStatus: 'online',
  takeover: true,
  archived: false,
  pinned: false,
  updatedSeq: 1,
  lastReadSeq: 0,
  latestTurnEndSeq: 0,
}
const runtimeState = {
  sessionId: session.id,
  externalSessionId: session.externalSessionId,
  runtime: 'dsh',
  runtimeId: 'dsh',
  runtimeType: 'dsh',
  status: 'running',
  selections: { model: 'fixture-model', permission: 'workspace-write' },
  metadata: {},
  updatedSeq: 1,
  createdAt: now,
  updatedAt: now,
}
const capabilities = {
  capabilities: [
    'session.send_message',
    'session.interrupt',
    'catalog.model',
    'catalog.permission',
  ].map((capabilityId) => ({
    capabilityId,
    runtime: 'dsh',
    supported: true,
    available: true,
    allowed: true,
  })),
}
const catalogs = {
  model: {
    models: [
      {
        id: 'fixture-model',
        selectionId: 'fixture-model',
        displayName: 'Fixture DeepSeek',
        enabled: true,
        metadata: {},
        reasoningItems: [],
      },
    ],
  },
  permission: {
    permissions: [
      {
        id: 'workspace-write',
        selectionId: 'workspace-write',
        displayName: '工作区写入',
        enabled: true,
        metadata: {},
      },
    ],
  },
}
function message(id, text, role, sequence) {
  return {
    id,
    sessionId: session.id,
    type: 'message',
    role,
    status: 'done',
    content: { text },
    source: {
      runtime: 'dsh',
      ...(role === 'user' ? { clientMessageId: 'client-message' } : {}),
    },
    orderSeq: sequence,
    updatedSeq: sequence,
    revision: 1,
    contentHash: id,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  }
}
const userMessage = message('user', '你好', 'user', 1)
const reply = message(
  'assistant',
  '你好！我可以帮助你处理项目。',
  'assistant',
  3,
)
function envelope(type, sequence, payload) {
  return {
    protocolVersion: '1.0',
    eventId: `event-${sequence}-${type}`,
    sequence,
    cursor: `seq:${sequence}`,
    sessionId: session.id,
    type,
    emittedAt: now,
    payload,
  }
}
function completedEvents() {
  return [
    envelope('timeline.item_created', 3, { item: reply }),
    envelope('runtime.state.updated', 4, {
      state: { ...runtimeState, status: 'idle', updatedSeq: 4 },
    }),
    envelope('session.meta.updated', 5, {
      session: { ...session, status: 'idle', updatedSeq: 5 },
    }),
  ]
}
function snapshot(completed = false) {
  return {
    session: {
      ...session,
      ...(completed ? { status: 'idle', updatedSeq: 5 } : {}),
    },
    state: {
      ...runtimeState,
      ...(completed ? { status: 'idle', updatedSeq: 4 } : {}),
    },
    timeline: {
      items: completed ? [userMessage, reply] : [userMessage],
      nextSeq: completed ? 5 : 1,
      hasMore: false,
    },
    eventCursor: completed ? 'seq:5' : 'seq:1',
    notices: [],
    catalogs,
    effectiveCapabilities: capabilities,
    runtimeCapabilities: capabilities,
    serverTime: now,
  }
}
let root
let container
function setup() {
  sockets.length = 0
  saveStoredSession({
    userId: 'fixture-owner',
    accessToken: 'fixture-token',
    authzVersion: 1,
  })
  globalThis.streamWorkspace = {
    addOptimisticMessage() {},
    clearResolvedOptimisticMessages() {},
    consumeComposerInsertion() {},
    composerInsertion: null,
    getOptimisticItems: () => [],
    getOptimisticSessionState: () => null,
    isOptimisticSession: () => false,
    markOptimisticMessageFailed() {},
    restoreFailedSessionDraft() {},
    refreshData() {},
    replaceHome() {},
  }
  dashboardApi.getSessionSnapshot = async () => snapshot()
  dashboardApi.createWsTicket = async () => ({ ticket: 'fixture-ticket' })
  dashboardApi.sessionWebSocketUrl = () => 'wss://fixture.example/session'
  dashboardApi.getSessionEvents = async () => ({
    events: [],
    nextCursor: 'seq:1',
    snapshotRequired: false,
  })
  dashboardApi.getSessionRuntimeCapabilities = async () => ({
    capabilitySet: capabilities,
    serverTime: now,
  })
}
async function render() {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      h(
        NextIntlClientProvider,
        { locale: 'zh-CN', messages },
        h(SessionDetail, {
          token: 'fixture-token',
          sessionId: session.id,
          fallbackSession: session,
        }),
      ),
    ),
  )
}
async function deliver(events) {
  await act(async () => {
    for (const event of events)
      sockets[0].onmessage({ data: JSON.stringify(event) })
    await new Promise((resolve) => setTimeout(resolve, 55))
  })
}
test.afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container?.remove()
  clearStoredSession()
})

test('the real session UI rejects the old missing-version envelope, then recovers a fast completed reply after a valid subscription', async () => {
  setup()
  let recoveries = 0
  dashboardApi.getSessionEvents = async () => {
    recoveries += 1
    return {
      events: completedEvents(),
      nextCursor: 'seq:5',
      snapshotRequired: false,
    }
  }
  await render()
  assert.ok(container.textContent.includes('DSH 正在工作'))
  assert.ok(container.textContent.includes('Fixture DeepSeek'))
  assert.ok(container.textContent.includes('工作区写入'))
  const invalid = [
    envelope('session.subscribed', 1, {}),
    ...completedEvents(),
  ].map(({ protocolVersion, ...event }) => event)
  assert.equal(parseProtocolEvent(JSON.stringify(invalid[0])), null)
  await deliver(invalid)
  assert.equal(recoveries, 0)
  assert.ok(container.textContent.includes('DSH 正在工作'))
  assert.ok(!container.textContent.includes(reply.content.text))
  await deliver([envelope('session.subscribed', 1, {})])
  assert.equal(recoveries, 1)
  assert.ok(container.textContent.includes(reply.content.text))
  assert.ok(!container.textContent.includes('DSH 正在工作'))
})

test('a turn completed before new-session binding is visible from the initial snapshot', async () => {
  setup()
  globalThis.streamWorkspace.getOptimisticSessionState = () => ({
    session: { ...session, status: 'waiting' },
    state: { ...runtimeState, status: 'waiting' },
    items: [
      {
        ...userMessage,
        id: 'optimistic-message:client-message',
        status: 'pending',
        source: { clientMessageId: 'client-message', optimistic: true },
      },
    ],
    nextSeq: 1,
    hasMore: false,
    serverTime: now,
  })
  dashboardApi.getSessionSnapshot = async () => snapshot(true)
  await render()
  assert.ok(container.textContent.includes(reply.content.text))
  assert.ok(!container.textContent.includes('DSH 正在工作'))
  assert.ok(!container.textContent.includes('等待 DSH'))
  assert.ok(container.textContent.includes('Fixture DeepSeek'))
})

test('live assistant completion and runtime idle render without another snapshot', async () => {
  setup()
  let snapshots = 0
  dashboardApi.getSessionSnapshot = async () => {
    snapshots += 1
    return snapshot()
  }
  await render()
  await deliver([envelope('session.subscribed', 1, {})])
  await deliver(completedEvents())
  assert.equal(snapshots, 1)
  assert.ok(container.textContent.includes(reply.content.text))
  assert.ok(!container.textContent.includes('DSH 正在工作'))
})
