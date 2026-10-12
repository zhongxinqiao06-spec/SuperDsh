import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { JSDOM } from 'jsdom'
import { registerSource } from './helpers/onboarding-source.mjs'

const dom = new JSDOM('<html><body></body></html>', {
  url: 'https://fixture.example/#/workspace',
  pretendToBeVisual: true,
})
for (const name of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLTextAreaElement',
  'HTMLInputElement',
  'Element',
  'Node',
  'Event',
  'MutationObserver',
  'getComputedStyle',
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
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const hooks = registerSource()
const overrides = registerHooks({
  load(url, context, nextLoad) {
    const mocks = {
      '/components/auth/auth-context.tsx':
        'export const useAuth = () => globalThis.composerAuth',
      '/components/workspace-context.tsx':
        'export const useWorkspace = () => globalThis.composerWorkspace',
      '/components/session-tool-sidebar-state.tsx':
        'export const useSessionToolSidebarStore = () => ({migrateSession(){}})',
      '/components/ui/sidebar.tsx':
        "export const useSidebar = () => ({isMobile:false,state:'expanded'})",
      '/components/workspace-picker.tsx':
        'export const WorkspacePicker = () => null',
    }
    for (const [suffix, source] of Object.entries(mocks))
      if (url.endsWith(suffix))
        return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})
const { TaskComposer } = await import('../src/components/task-composer.tsx')
const { workbenchCell } = await import('../src/features/workbench/memory.ts')
const { saveStoredSession, clearStoredSession } =
  await import('../src/features/auth/session.ts')
const { dashboardApi } = await import('../src/features/dashboard/api.ts')
overrides.deregister()
hooks.deregister()
const messages = JSON.parse(
  readFileSync(new URL('../messages/zh-CN.json', import.meta.url), 'utf8'),
)
const runtime = {
  connectorId: 'computer',
  runtimeId: 'dsh',
  runtimeType: 'dsh',
  configured: true,
  active: true,
  present: true,
  status: 'running',
  displayName: 'DSH',
  metadata: {},
  discovery: {},
  config: null,
}
const project = {
  id: 'project',
  connectorId: 'computer',
  name: 'My project',
  workspacePath: '/my-project',
}
const model = (id) => ({
  id,
  selectionId: id,
  displayName: id,
  enabled: true,
  reasoningItems: [],
  metadata: {},
  default: id === 'first-model',
})
const capabilitySet = {
  capabilities: [
    'catalog.model',
    'catalog.permission',
    'runtime.attachment',
    'session.send_message',
  ].map((capabilityId) => ({
    capabilityId,
    supported: true,
    available: true,
    allowed: true,
  })),
}
let root
let container
async function mount() {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      h(NextIntlClientProvider, { locale: 'zh-CN', messages }, h(TaskComposer)),
    ),
  )
}
async function unmount() {
  await act(async () => root?.unmount())
  root = null
  container?.remove()
}
test.afterEach(async () => {
  await unmount()
  clearStoredSession()
  window.localStorage.clear()
})

function setupComposer() {
  const session = {
    userId: 'creator',
    accessToken: 'fixture-token',
    authzVersion: 1,
    role: 'member',
    roles: ['member'],
    permissions: ['sessions.run'],
  }
  saveStoredSession(session)
  globalThis.composerAuth = {
    session,
    can: (permission) => session.permissions.includes(permission),
  }
  let optimistic
  let binding
  globalThis.composerWorkspace = {
    connectors: [
      {
        id: 'computer',
        name: 'My computer',
        status: 'online',
        executorKind: 'desktop',
      },
    ],
    projects: [project],
    sessions: [],
    newSessionProject: null,
    isLoading: false,
    sidebarShowsSessions: true,
    addOptimisticMessage: (value) => {
      optimistic = value
    },
    bindOptimisticSession: (...value) => {
      binding = value
    },
    createProject() {},
    goHome() {},
    markOptimisticMessageFailed() {},
    openSession() {},
    refreshData() {},
    resolveProject: async () => project,
    updateProject() {},
  }
  dashboardApi.getConnectorRuntimes = async () => ({ runtimes: [runtime] })
  dashboardApi.getConnectorRuntimeCapabilities = async () => ({
    capabilitySet,
  })
  dashboardApi.getConnectorRuntimeModelCatalog = async () => ({
    catalog: { models: [model('first-model'), model('chosen-model')] },
  })
  dashboardApi.getConnectorRuntimePermissionCatalog = async () => ({
    catalog: {
      permissions: [
        {
          id: 'ask',
          selectionId: 'ask',
          displayName: 'Ask',
          enabled: true,
          metadata: {},
        },
      ],
    },
  })
  return {
    session,
    get optimistic() {
      return optimistic
    },
    get binding() {
      return binding
    },
  }
}

test(
  'actual new-session composer retains its draft, files and selected runtime/model across a slow inventory remount, and sends only once',
  { timeout: 5_000 },
  async () => {
    const fixture = setupComposer()
    const selected = {
      device: 'computer',
      runtime: 'dsh',
      model: 'chosen-model',
      permission: 'ask',
      prompt: 'Retained draft',
      workspace: {
        connectorId: 'computer',
        projectId: project.id,
        path: project.workspacePath,
        label: project.name,
      },
    }
    for (const [key, value] of Object.entries(selected))
      workbenchCell(`new-session/${key}`, value)
    const file = new File(['attached'], 'draft.txt', { type: 'text/plain' })
    workbenchCell('new-session/attachments', [
      {
        id: 'file',
        file,
        name: file.name,
        type: 'file',
        size: file.size,
        mediaType: file.type,
        uploadStatus: 'local',
      },
    ])
    await mount()
    assert.equal(container.querySelector('textarea').value, 'Retained draft')
    assert.match(container.textContent, /chosen-model/)
    assert.match(container.textContent, /draft.txt/)
    await unmount()
    let releaseInventory
    dashboardApi.getConnectorRuntimes = async () =>
      new Promise((resolve) => {
        releaseInventory = resolve
      })
    await mount()
    assert.equal(workbenchCell('new-session/device', '').get(), 'computer')
    assert.equal(workbenchCell('new-session/runtime', '').get(), 'dsh')
    assert.equal(workbenchCell('new-session/model', '').get(), 'chosen-model')
    assert.equal(
      workbenchCell('new-session/workspace', null).get().path,
      '/my-project',
    )
    assert.equal(
      workbenchCell('new-session/attachments', []).get()[0].file,
      file,
    )
    await act(async () => releaseInventory({ runtimes: [runtime] }))
    assert.match(container.textContent, /chosen-model/)
    let releaseCreate
    let requests = 0
    let body
    let notifyStarted
    const requestStarted = new Promise((resolve) => {
      notifyStarted = resolve
    })
    dashboardApi.createAndStartSession = async (_token, value) => {
      requests += 1
      body = value
      notifyStarted()
      return new Promise((resolve) => {
        releaseCreate = resolve
      })
    }
    const button = container.querySelector(
      `button[aria-label="${messages.dashboard.new.sendTask}"]`,
    )
    assert.equal(button.disabled, false)
    await act(async () => {
      button.click()
      await requestStarted
    })
    assert.equal(requests, 1)
    assert.equal(body.clientMessageId, fixture.optimistic.clientMessageId)
    assert.equal(body.selections.model, 'chosen-model')
    assert.equal(body.attachments[0].name, 'draft.txt')
    await unmount()
    dashboardApi.getConnectorRuntimes = async () => ({ runtimes: [runtime] })
    await mount()
    assert.equal(workbenchCell('new-session/creating', false).get(), true)
    assert.equal(
      container.querySelector(
        `button[aria-label="${messages.dashboard.new.sendTask}"]`,
      ).disabled,
      true,
    )
    await act(async () =>
      releaseCreate({
        session: { ...fixture.optimistic.session, id: 'real-session' },
        attachments: [],
      }),
    )
    assert.equal(workbenchCell('new-session/creating', false).get(), false)
    assert.equal(requests, 1)
    assert.equal(fixture.binding[0], fixture.optimistic.localSessionId)
    assert.equal(fixture.binding[1].id, 'real-session')
  },
)

for (const mode of ['permissions', 'logout-and-login']) {
  test(`new-session preparation is safely released after ${mode} changes during project resolution`, async () => {
    const fixture = setupComposer()
    workbenchCell('new-session/device', 'computer')
    workbenchCell('new-session/runtime', 'dsh')
    workbenchCell('new-session/model', 'chosen-model')
    workbenchCell('new-session/permission', 'ask')
    workbenchCell('new-session/prompt', 'Still my draft')
    workbenchCell('new-session/workspace', {
      connectorId: 'computer',
      projectId: project.id,
      path: project.workspacePath,
      label: project.name,
    })
    let resolveProject
    globalThis.composerWorkspace.resolveProject = () =>
      new Promise((resolve) => {
        resolveProject = resolve
      })
    let sends = 0
    dashboardApi.createAndStartSession = async () => {
      sends += 1
    }
    await mount()
    const oldCreating = workbenchCell('new-session/creating', false)
    await act(async () =>
      container
        .querySelector(
          `button[aria-label="${messages.dashboard.new.sendTask}"]`,
        )
        .click(),
    )
    assert.equal(oldCreating.get(), true)
    await act(async () => {
      if (mode === 'permissions') {
        saveStoredSession({ ...fixture.session, authzVersion: 2 })
      } else {
        clearStoredSession()
        saveStoredSession(fixture.session)
        workbenchCell('new-session/creating', true)
      }
      resolveProject(project)
    })
    assert.equal(sends, 0)
    if (mode === 'permissions') {
      assert.equal(oldCreating.get(), false)
      assert.equal(
        workbenchCell('new-session/prompt', '').get(),
        'Still my draft',
      )
    } else {
      assert.equal(oldCreating.current(), false)
      assert.equal(workbenchCell('new-session/creating', false).get(), true)
    }
  })
}
