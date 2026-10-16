import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
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
  'Event',
  'Node',
  'MutationObserver',
  'requestAnimationFrame',
  'cancelAnimationFrame',
]) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: dom.window[name],
  })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const revoked = []
URL.revokeObjectURL = (value) => revoked.push(value)
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
const hooks = registerSource()
const overrides = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/components/auth/auth-context.tsx'))
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export const useAuth = () => globalThis.workbenchAuth',
      }
    return nextLoad(url, context)
  },
})
const { saveStoredSession, clearStoredSession, loadStoredSession } =
  await import('../src/features/auth/session.ts')
const { workbenchCell, useWorkbenchState } =
  await import('../src/features/workbench/memory.ts')
const { useAttachments } =
  await import('../src/components/attachment-input.tsx')
const { WorkspaceProvider, useWorkspace } =
  await import('../src/components/workspace-context.tsx')
const { dashboardApi } = await import('../src/features/dashboard/api.ts')
const { serverAgentApi } =
  await import('../src/features/dashboard/server-agent.ts')
const { prepareWorkbenchAgent } =
  await import('../src/features/workbench/agent-lifecycle.tsx')
overrides.deregister()
hooks.deregister()
const messages = JSON.parse(
  readFileSync(new URL('../messages/zh-CN.json', import.meta.url), 'utf8'),
)
const session = (id) => ({
  userId: id,
  accessToken: `token-${id}`,
  authzVersion: 1,
  roles: ['member'],
  permissions: [],
})
function login(id) {
  clearStoredSession()
  saveStoredSession(session(id))
  globalThis.workbenchAuth = { session: loadStoredSession(), can: () => true }
}
let root
async function mount(children) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      h(NextIntlClientProvider, { locale: 'zh-CN', messages }, children),
    ),
  )
  return container
}
async function unmount() {
  await act(async () => root?.unmount())
  root = null
  document.body.replaceChildren()
}
test.afterEach(async () => {
  await unmount()
  clearStoredSession()
})

test('workbench unmount preserves draft, real File, target selections and an upload that finishes while away', async () => {
  login('first')
  let resolveUpload
  let uploads = 0
  dashboardApi.uploadSessionAttachments = async () => {
    uploads += 1
    return new Promise((resolve) => {
      resolveUpload = resolve
    })
  }
  let probe
  function Draft() {
    const [text, setText] = useWorkbenchState('session/test/draft', '')
    const [target, setTarget] = useWorkbenchState('new-session/workspace', null)
    const attachments = useAttachments({
      sessionId: 'test',
      token: 'token-first',
    })
    probe = { text, setText, target, setTarget, ...attachments }
    return h('div', null, text)
  }
  await mount(h(Draft))
  const file = new File(['fixture'], 'note.txt', { type: 'text/plain' })
  await act(async () => {
    probe.setText('unsent draft')
    probe.setTarget({
      connectorId: 'computer-a',
      runtimeId: 'dsh',
      path: '/workspace',
      model: 'personal/deepseek',
      permission: 'ask',
    })
    probe.add([
      {
        id: 'attachment',
        file,
        name: file.name,
        type: 'file',
        size: file.size,
        mediaType: file.type,
        uploadStatus: 'local',
      },
    ])
  })
  assert.equal(probe.attachments[0].uploadStatus, 'uploading')
  await unmount()
  resolveUpload({ attachments: [{ fileId: 'uploaded-id' }] })
  await Promise.resolve()
  await mount(h(Draft))
  assert.equal(probe.text, 'unsent draft')
  assert.equal(probe.attachments[0].file, file)
  assert.equal(probe.attachments[0].uploadStatus, 'uploaded')
  assert.equal(probe.attachments[0].uploaded.fileId, 'uploaded-id')
  assert.equal(probe.target.connectorId, 'computer-a')
  assert.equal(probe.target.model, 'personal/deepseek')
  assert.equal(uploads, 1)
})

test('account changes discard files, revoke previews and fence old writes even when the old account logs in again', () => {
  login('first')
  const old = workbenchCell('draft', {
    text: 'private',
    attachments: [{ preview: 'blob:private' }],
  })
  const pending = workbenchCell('pending-send', true)
  saveStoredSession(session('second'))
  old.set({ text: 'late response' })
  pending.set(false)
  assert.equal(old.current(), false)
  assert.ok(revoked.includes('blob:private'))
  assert.deepEqual(workbenchCell('draft', { text: '' }).get(), { text: '' })
  clearStoredSession()
  saveStoredSession(session('first'))
  old.set({ text: 'late old-account response' })
  assert.deepEqual(workbenchCell('draft', { text: '' }).get(), { text: '' })
})

test('an in-flight session creation binds its original client message after module unmount without hijacking management navigation', async () => {
  login('creator')
  sockets.length = 0
  dashboardApi.createDashboardWsTicket = async () => ({ ticket: 'fixture' })
  dashboardApi.dashboardWebSocketUrl = () => 'wss://fixture.example/ws'
  let workspace
  function Probe() {
    workspace = useWorkspace()
    return null
  }
  window.location.hash = '#/workspace/session/session_local'
  await mount(h(WorkspaceProvider, null, h(Probe)))
  const original = workspace
  const record = {
    id: 'session_local',
    connectorId: 'desktop',
    projectId: 'project',
    runtime: 'dsh',
    runtimeId: 'dsh',
    runtimeType: 'dsh',
    title: 'First message',
    status: 'waiting',
    connectorStatus: 'online',
    updatedSeq: 1,
    lastReadSeq: 0,
    latestTurnEndSeq: 0,
    cwd: '/workspace',
    takeover: true,
  }
  await act(async () =>
    original.addOptimisticMessage({
      clientMessageId: 'message-one',
      localSessionId: record.id,
      sessionId: record.id,
      session: record,
      item: {
        id: 'local-message',
        sessionId: record.id,
        type: 'message',
        role: 'user',
        source: { clientMessageId: 'message-one', optimistic: true },
        content: { text: 'Hello' },
        updatedSeq: 1,
      },
    }),
  )
  assert.equal(workspace.optimisticMessages.length, 1)
  await unmount()
  assert.ok(sockets.every((socket) => socket.closed))
  window.location.hash = '#/access/users'
  const draft = workbenchCell(`session/${record.id}/draft`, {
    sessionId: record.id,
    value: 'Follow-up typed while creation is pending',
  })
  const files = workbenchCell(`session/${record.id}/attachments`, [])
  const file = new File(['later'], 'follow-up.txt', { type: 'text/plain' })
  files.set([{ file, id: 'follow-up', uploadStatus: 'local' }])
  original.bindOptimisticSession(record.id, {
    ...record,
    id: 'session_canonical',
  })
  assert.equal(window.location.hash, '#/access/users')
  window.location.hash = '#/workspace'
  await mount(h(WorkspaceProvider, null, h(Probe)))
  assert.equal(window.location.hash, '#/workspace/session/session_local')
  assert.equal(workspace.activeSessionId, 'session_canonical')
  assert.equal(workspace.activeSession.title, 'First message')
  assert.equal(workspace.optimisticMessages[0].clientMessageId, 'message-one')
  assert.equal(workspace.optimisticMessages.length, 1)
  assert.equal(
    workbenchCell('session/session_canonical/draft', null).get().value,
    draft.get().value,
  )
  assert.equal(
    workbenchCell('session/session_canonical/draft', null).get().sessionId,
    'session_canonical',
  )
  assert.equal(
    workbenchCell('session/session_canonical/attachments', []).get()[0].file,
    file,
  )
  files.set((current) =>
    current.map((value) => ({ ...value, uploadStatus: 'uploaded' })),
  )
  assert.equal(
    workbenchCell('session/session_canonical/attachments', []).get()[0]
      .uploadStatus,
    'uploaded',
  )
  await act(async () => workspace.goHome())
  await unmount()
  await mount(h(WorkspaceProvider, null, h(Probe)))
  assert.equal(workspace.page, 'home')
})

test('pending send state survives remount and completion cannot clear another account send state', async () => {
  login('sender')
  let status
  function Pending() {
    const [pending, setPending] = useWorkbenchState('session/sending', false)
    status = { pending, setPending }
    return null
  }
  await mount(h(Pending))
  const original = status
  await act(async () => original.setPending(true))
  await unmount()
  await mount(h(Pending))
  assert.equal(status.pending, true)
  await act(async () => original.setPending(false))
  assert.equal(status.pending, false)
  await unmount()
  login('other-sender')
  await mount(h(Pending))
  await act(async () => status.setPending(true))
  original.setPending(false)
  assert.equal(status.pending, true)
})

test('failed new-session creation stops waiting and retains the failure across a workspace remount', async () => {
  login('failed-creator')
  globalThis.workbenchAuth.can = () => false
  let workspace
  function Probe() {
    workspace = useWorkspace()
    return null
  }
  await mount(h(WorkspaceProvider, null, h(Probe)))
  const id = 'session_failed_local'
  const originalFile = new File(['fixture'], '未发送.txt', {
    type: 'text/plain',
  })
  const attachments = [
    {
      id: 'original-file',
      file: originalFile,
      name: originalFile.name,
      type: 'file',
      size: originalFile.size,
      mediaType: originalFile.type,
      uploadStatus: 'local',
    },
  ]
  const record = {
    id,
    connectorId: 'server-agent',
    runtime: 'dsh',
    runtimeId: 'dsh',
    title: '你好',
    status: 'waiting',
    connectorStatus: 'online',
    updatedSeq: 1,
    lastReadSeq: 0,
    latestTurnEndSeq: 0,
    cwd: '/owned-workspace',
    takeover: true,
  }
  await act(async () => {
    workspace.addOptimisticMessage({
      clientMessageId: 'failed-create',
      localSessionId: id,
      sessionId: id,
      session: record,
      draft: {
        prompt: '你好',
        attachments,
        device: record.connectorId,
        runtime: record.runtime,
        model: 'chosen-model',
        reasoning: 'high',
        permission: 'ask',
        workspace: {
          connectorId: record.connectorId,
          projectId: 'canonical',
          path: record.cwd,
        },
      },
      state: {
        sessionId: id,
        runtime: 'dsh',
        status: 'waiting',
        selections: {},
        metadata: {},
        updatedSeq: 1,
      },
      item: {
        id: 'optimistic-message:failed-create',
        sessionId: id,
        type: 'message',
        role: 'user',
        status: 'pending',
        source: { clientMessageId: 'failed-create', optimistic: true },
        content: { text: '你好' },
        updatedSeq: 1,
      },
    })
  })
  const diagnostic = 'The selected model is no longer available'
  await act(async () =>
    workspace.markOptimisticMessageFailed('failed-create', diagnostic),
  )
  for (const remount of [false, true]) {
    if (remount) {
      await unmount()
      await mount(h(WorkspaceProvider, null, h(Probe)))
    }
    const failed = workspace.getOptimisticSessionState(id)
    assert.equal(failed.session.status, 'error')
    assert.equal(failed.state.status, 'error')
    assert.deepEqual(failed.state.error, { message: diagnostic })
    assert.equal(failed.items[0].status, 'failed')
    assert.equal(failed.items[0].content.text, '你好')
    assert.equal(failed.items[0].content.error, diagnostic)
  }
  assert.equal(workbenchCell('new-session/prompt', '').get(), '')
  assert.deepEqual(workbenchCell('new-session/attachments', []).get(), [])
  await act(async () =>
    workspace.markOptimisticMessageFailed(
      'failed-create',
      'Outcome unknown',
      'unknown',
    ),
  )
  assert.equal(workspace.restoreFailedSessionDraft(id, true), 'missing')
  assert.equal(
    workspace.getOptimisticSessionState(id).state.error.code,
    'SESSION_CREATION_OUTCOME_UNKNOWN',
  )
  assert.equal(workbenchCell('new-session/prompt', '').get(), '')
  await act(async () =>
    workspace.markOptimisticMessageFailed(
      'failed-create',
      diagnostic,
      'rejected',
    ),
  )
  await act(async () => {
    assert.equal(workspace.restoreFailedSessionDraft(id), 'restored')
  })
  assert.equal(workbenchCell('new-session/prompt', '').get(), '你好')
  assert.equal(
    workbenchCell('new-session/attachments', []).get()[0].file,
    originalFile,
  )
  assert.equal(workbenchCell('new-session/model', '').get(), 'chosen-model')
  assert.equal(workbenchCell('new-session/reasoning', '').get(), 'high')
  assert.equal(workbenchCell('new-session/permission', '').get(), 'ask')
  assert.equal(workspace.page, 'home')
  assert.equal(
    workspace.getOptimisticSessionState(id).items[0].status,
    'failed',
  )
  workbenchCell('new-session/prompt', '').set('A different unsent draft')
  assert.equal(workspace.restoreFailedSessionDraft(id), 'conflict')
  assert.equal(
    workbenchCell('new-session/prompt', '').get(),
    'A different unsent draft',
  )
  await act(async () => {
    assert.equal(workspace.restoreFailedSessionDraft(id, true), 'restored')
  })
  assert.equal(workbenchCell('new-session/prompt', '').get(), '你好')
  const previousWorkspace = workspace
  await unmount()
  login('another-account')
  assert.equal(previousWorkspace.restoreFailedSessionDraft(id, true), 'missing')
  assert.equal(workbenchCell('new-session/prompt', '').get(), '')
  assert.deepEqual(workbenchCell('new-session/attachments', []).get(), [])
})

test('a rejected follow-up does not replace the running authoritative session state', async () => {
  login('failed-follow-up')
  globalThis.workbenchAuth.can = () => false
  let workspace
  function Probe() {
    workspace = useWorkspace()
    return null
  }
  await mount(h(WorkspaceProvider, null, h(Probe)))
  await act(async () => {
    workspace.addOptimisticMessage({
      clientMessageId: 'rejected-follow-up',
      localSessionId: 'previous-local-id',
      sessionId: 'canonical-id',
      session: { id: 'canonical-id', status: 'running' },
      state: { sessionId: 'canonical-id', status: 'running' },
      item: {
        id: 'optimistic-message:rejected-follow-up',
        sessionId: 'canonical-id',
        type: 'message',
        role: 'user',
        status: 'pending',
        source: { clientMessageId: 'rejected-follow-up', optimistic: true },
        content: { text: 'Follow-up' },
        updatedSeq: 1,
      },
    })
  })
  await act(async () =>
    workspace.markOptimisticMessageFailed('rejected-follow-up', 'Forbidden'),
  )
  const failed = workspace.getOptimisticSessionState('canonical-id')
  assert.equal(failed.items[0].status, 'failed')
  assert.equal(failed.session.status, 'running')
  assert.equal(failed.state.status, 'running')
})

test('workspace project resolution cannot create or refresh under a newly logged-in account', async () => {
  login('project-owner')
  globalThis.workbenchAuth.can = () => false
  let workspace
  function Probe() {
    workspace = useWorkspace()
    return null
  }
  await mount(h(WorkspaceProvider, null, h(Probe)))
  let releaseList
  let lists = 0
  let creates = 0
  dashboardApi.listProjects = () => {
    lists += 1
    return new Promise((resolve) => {
      releaseList = resolve
    })
  }
  dashboardApi.createProject = async () => {
    creates += 1
  }
  const oldWorkspace = workspace
  const resolving = oldWorkspace.resolveProject({
    connectorId: 'desktop',
    workspacePath: '/new',
  })
  const rejected = assert.rejects(resolving, /Account changed/)
  await unmount()
  login('new-owner')
  releaseList({ projects: [] })
  await rejected
  assert.equal(creates, 0)
  assert.equal(
    await oldWorkspace.createProject({
      name: 'Old project',
      connectorId: 'desktop',
      workspacePath: '/old',
    }),
    null,
  )
  assert.equal(await oldWorkspace.refreshData(), false)
  assert.equal(lists, 1)
})

test('Agent preparation is single flight, reuses running instances, and failed or unavailable instances require explicit retry', async () => {
  login('agent')
  let reads = 0
  let prepares = 0
  let release
  serverAgentApi.get = async () => {
    reads += 1
    return new Promise((resolve) => {
      release = resolve
    })
  }
  serverAgentApi.prepare = async () => {
    prepares += 1
  }
  const first = prepareWorkbenchAgent()
  const duplicate = prepareWorkbenchAgent()
  assert.equal(first, duplicate)
  release({ agent: { status: 'stopped', error: null } })
  await first
  await prepareWorkbenchAgent()
  assert.equal(prepares, 1)
  assert.equal(reads, 1)
  for (const status of ['running', 'starting', 'error']) {
    login(`agent-${status}`)
    serverAgentApi.get = async () => ({
      agent: { status, error: status === 'error' ? 'failed' : null },
    })
    await prepareWorkbenchAgent()
    assert.equal(prepares, 1)
  }
  await prepareWorkbenchAgent(true)
  assert.equal(prepares, 2)
})
