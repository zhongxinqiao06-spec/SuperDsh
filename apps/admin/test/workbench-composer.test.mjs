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
const { serverAgentApi } =
  await import('../src/features/dashboard/server-agent.ts')
const { agentsApi } = await import('../src/features/agents/api.ts')
const { apiClient } = await import('../src/lib/api/index.ts')
const { ApiError } = await import('../src/lib/api/errors.ts')
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
  agentsApi.available = async () => ({ items: [], total: 0 })
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
  let failure
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
    markOptimisticMessageFailed(...value) {
      failure = value
    },
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
  serverAgentApi.get = async () => {
    assert.fail('desktop sessions must not depend on server Agent binding')
  }
  return {
    session,
    get optimistic() {
      return optimistic
    },
    get binding() {
      return binding
    },
    get failure() {
      return failure
    },
  }
}

test('a published business agent uses the main session request and survives explicit rejection in its draft', async (t) => {
  const fixture = prepareServerComposer(t)
  agentsApi.available = async () => ({
    items: [
      {
        id: 'sales-agent',
        name: '销售分析助手',
        description: '按模板分析销售数据',
        published: true,
        version: 2,
      },
    ],
    total: 1,
  })
  workbenchCell('new-session/agent-definition', 'sales-agent')
  let body
  dashboardApi.createAndStartSession = async (_token, value) => {
    body = value
    throw new ApiError({
      status: 422,
      detail: 'Model unavailable',
      kind: 'http',
    })
  }
  await mount()
  assert.equal(
    container.querySelector('select[aria-label="业务智能体"]').value,
    'sales-agent',
  )
  assert.equal(fixture.sendButton().disabled, false)
  await act(async () => fixture.sendButton().click())
  assert.equal(body.agentDefinitionId, 'sales-agent')
  assert.equal(body.projectId, 'canonical-project')
  assert.equal(fixture.optimistic.draft.agentDefinitionId, 'sales-agent')
  assert.equal(fixture.failure[2], 'rejected')
})

test('a remembered removed or unpublished business agent blocks a new send until the user chooses general chat', async (t) => {
  const fixture = prepareServerComposer(t)
  workbenchCell('new-session/agent-definition', 'removed-agent')
  await mount()
  assert.equal(fixture.sendButton().disabled, true)
  assert.match(container.textContent, /已删除或取消发布/)
  const select = container.querySelector('select[aria-label="业务智能体"]')
  await act(async () => {
    select.value = ''
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  assert.equal(fixture.sendButton().disabled, false)
})

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
    assert.equal(fixture.optimistic.draft.prompt, 'Retained draft')
    assert.equal(fixture.optimistic.draft.attachments[0].file, file)
    assert.equal(fixture.optimistic.draft.model, 'chosen-model')
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

for (const workspacePath of [
  String.raw`D:\项目\SuperDsh 数据\agents\用户\workspace`,
  '/srv/superdsh/用户工作区/workspace',
]) {
  test(`server Agent selects its owned native project and sends from ${workspacePath}`, async (t) => {
    const fixture = setupComposer()
    const serverProject = {
      id: 'server-project',
      connectorId: 'server-agent',
      name: '服务端工作区',
      workspacePath,
    }
    globalThis.composerWorkspace.connectors = [
      {
        id: 'server-agent',
        name: '服务端 Agent',
        status: 'online',
        executorKind: 'server-agent',
      },
    ]
    // A desktop project's legacy container-shaped path must not win selection.
    globalThis.composerWorkspace.projects = [
      {
        ...serverProject,
        id: 'newer-duplicate',
        name: 'Duplicated historical project',
      },
      { ...project, workspacePath: '/workspace' },
      serverProject,
    ]
    globalThis.composerWorkspace.resolveProject = () => {
      assert.fail('server Agent must reuse its bound project')
    }
    dashboardApi.getConnectorRuntimes = async () => ({
      runtimes: [{ ...runtime, connectorId: 'server-agent' }],
    })
    serverAgentApi.get = async () => ({
      agent: {
        status: 'running',
        connectorId: 'server-agent',
        runtimeId: 'dsh',
        projectId: serverProject.id,
        error: null,
      },
    })
    t.mock.method(apiClient, 'get', async (path) => {
      assert.equal(path, '/models/catalog')
      return { scope: 'personal', default: null }
    })
    for (const [key, value] of Object.entries({
      device: 'server-agent',
      runtime: 'dsh',
      model: 'chosen-model',
      permission: 'ask',
      prompt: '在服务端原生工作区执行',
    }))
      workbenchCell(`new-session/${key}`, value)
    let body
    let sends = 0
    dashboardApi.createAndStartSession = async (_token, value) => {
      body = value
      sends += 1
      return {
        session: { ...fixture.optimistic.session, id: 'native-session' },
        attachments: [],
      }
    }

    await mount()
    assert.deepEqual(workbenchCell('new-session/workspace', null).get(), {
      connectorId: serverProject.connectorId,
      projectId: serverProject.id,
      label: serverProject.name,
      path: workspacePath,
    })
    assert.ok(container.textContent.includes(workspacePath))
    const send = container.querySelector(
      `button[aria-label="${messages.dashboard.new.sendTask}"]`,
    )
    assert.equal(send.disabled, false)
    await act(async () => send.click())
    assert.equal(sends, 1)
    assert.equal(body.projectId, serverProject.id)
    assert.equal(body.connectorId, serverProject.connectorId)
    assert.equal(body.cwd, workspacePath)
    assert.equal(body.selections.model, 'chosen-model')
    assert.equal(fixture.optimistic.session.cwd, workspacePath)
    assert.equal(fixture.binding[1].id, 'native-session')
  })
}

function prepareServerComposer(t) {
  const fixture = setupComposer()
  const serverProject = {
    id: 'canonical-project',
    connectorId: 'server-agent',
    name: '服务端工作区',
    workspacePath: '/owned-workspace',
  }
  const agent = {
    status: 'running',
    connectorId: 'server-agent',
    runtimeId: 'dsh',
    projectId: serverProject.id,
    error: null,
  }
  globalThis.composerWorkspace.connectors = [
    {
      id: 'server-agent',
      name: '服务端 Agent',
      status: 'online',
      executorKind: 'server-agent',
    },
  ]
  globalThis.composerWorkspace.projects = [
    { ...serverProject, id: 'wrong-project' },
    serverProject,
  ]
  globalThis.composerWorkspace.resolveProject = () => {
    assert.fail('server Agent must not create arbitrary projects')
  }
  dashboardApi.getConnectorRuntimes = async () => ({
    runtimes: [{ ...runtime, connectorId: 'server-agent' }],
  })
  t.mock.method(apiClient, 'get', async (path) => {
    assert.equal(path, '/models/catalog')
    return { scope: 'personal', default: null }
  })
  for (const [key, value] of Object.entries({
    device: 'server-agent',
    runtime: 'dsh',
    model: 'chosen-model',
    permission: 'ask',
    prompt: '在服务端原生工作区执行',
    workspace: {
      connectorId: 'server-agent',
      projectId: 'wrong-project',
      path: '/owned-workspace',
      label: 'Stale project',
    },
  }))
    workbenchCell(`new-session/${key}`, value)
  serverAgentApi.get = async () => ({ agent })
  let sends = 0
  dashboardApi.createAndStartSession = async () => {
    sends += 1
    return {
      session: { ...fixture.optimistic.session, id: 'native-session' },
      attachments: [],
    }
  }
  return {
    ...fixture,
    agent,
    serverProject,
    sendButton: () =>
      container.querySelector(
        `button[aria-label="${messages.dashboard.new.sendTask}"]`,
      ),
    get sends() {
      return sends
    },
    get failure() {
      return fixture.failure
    },
    get binding() {
      return fixture.binding
    },
    get optimistic() {
      return fixture.optimistic
    },
  }
}

test('server Agent binding must resolve before a remembered project can be sent', async (t) => {
  const fixture = prepareServerComposer(t)
  let release
  serverAgentApi.get = () => new Promise((resolve) => (release = resolve))
  await mount()
  assert.equal(fixture.sendButton().disabled, true)
  assert.equal(workbenchCell('new-session/workspace', null).get(), null)
  assert.ok(container.textContent.includes('正在确认服务端工作区'))
  await act(async () => fixture.sendButton().click())
  assert.equal(fixture.sends, 0)
  await act(async () => release({ agent: fixture.agent }))
  assert.equal(fixture.sendButton().disabled, false)
  assert.equal(
    workbenchCell('new-session/workspace', null).get().projectId,
    'canonical-project',
  )
})

test('binding fetch failure disables send and shows a retry which resolves the canonical project', async (t) => {
  const fixture = prepareServerComposer(t)
  serverAgentApi.get = async () => {
    throw new Error('Agent binding temporarily unavailable')
  }
  await mount()
  assert.equal(fixture.sendButton().disabled, true)
  assert.ok(
    container
      .querySelector('[role="alert"]')
      .textContent.includes('Agent binding temporarily unavailable'),
  )
  assert.equal(workbenchCell('new-session/workspace', null).get(), null)
  serverAgentApi.get = async () => ({ agent: fixture.agent })
  await act(async () =>
    [...container.querySelectorAll('button')]
      .find((button) => button.textContent === '重试')
      .click(),
  )
  assert.equal(fixture.sendButton().disabled, false)
  assert.equal(container.querySelector('[role="alert"]'), null)
})

test('opening a historical duplicate project still uses the managed server Agent project', async (t) => {
  const fixture = prepareServerComposer(t)
  globalThis.composerWorkspace.newSessionProject = {
    ...fixture.serverProject,
    id: 'wrong-project',
  }
  await mount()
  assert.equal(fixture.sendButton().disabled, false)
  assert.equal(
    workbenchCell('new-session/workspace', null).get().projectId,
    fixture.agent.projectId,
  )
})

for (const mismatch of [
  { connectorId: 'another-device' },
  { runtimeId: 'another-runtime' },
  { projectId: 'missing-project' },
]) {
  test(`unmatched server Agent binding cannot use a convenient first project: ${JSON.stringify(mismatch)}`, async (t) => {
    const fixture = prepareServerComposer(t)
    serverAgentApi.get = async () => ({
      agent: { ...fixture.agent, ...mismatch },
    })
    await mount()
    assert.equal(fixture.sendButton().disabled, true)
    assert.equal(workbenchCell('new-session/workspace', null).get(), null)
    assert.equal(fixture.sends, 0)
  })
}

test('a late server Agent binding from the previous account cannot select its project for the new account', async (t) => {
  const fixture = prepareServerComposer(t)
  let releaseOld
  serverAgentApi.get = () => new Promise((resolve) => (releaseOld = resolve))
  await mount()
  assert.equal(fixture.sendButton().disabled, true)
  await unmount()
  clearStoredSession()
  const account = { ...fixture.session, userId: 'new-account' }
  saveStoredSession(account)
  globalThis.composerAuth = {
    session: account,
    can: (permission) => account.permissions.includes(permission),
  }
  globalThis.composerWorkspace.projects = [
    { ...fixture.serverProject, id: 'new-owner-project' },
  ]
  serverAgentApi.get = async () => ({
    agent: { ...fixture.agent, projectId: 'new-owner-project' },
  })
  await mount()
  assert.equal(
    workbenchCell('new-session/workspace', null).get().projectId,
    'new-owner-project',
  )
  await act(async () => releaseOld({ agent: fixture.agent }))
  assert.equal(
    workbenchCell('new-session/workspace', null).get().projectId,
    'new-owner-project',
  )
  assert.equal(fixture.sends, 0)
})

for (const [error, outcome] of [
  [
    new ApiError({ status: 403, detail: 'Target rejected', kind: 'forbidden' }),
    'rejected',
  ],
  [
    new ApiError({
      status: 422,
      detail: 'Model unavailable',
      kind: 'validation',
    }),
    'rejected',
  ],
  [new Error('Connection lost after submission'), 'unknown'],
  [
    new ApiError({
      status: 409,
      detail: 'Outcome unknown',
      kind: 'http',
      code: 'session_create_outcome_unknown',
    }),
    'unknown',
  ],
  [
    new ApiError({ status: 500, detail: 'Server unavailable', kind: 'server' }),
    'unknown',
  ],
]) {
  test(`new-session recovery classifies ${error.message} as ${outcome} without resubmitting`, async (t) => {
    const fixture = prepareServerComposer(t)
    let requests = 0
    dashboardApi.createAndStartSession = async () => {
      requests += 1
      throw error
    }
    await mount()
    await act(async () => fixture.sendButton().click())
    assert.equal(requests, 1)
    assert.equal(fixture.failure[1], error.message)
    assert.equal(fixture.failure[2], outcome)
    assert.equal(workbenchCell('new-session/creating', false).get(), false)
  })
}

test('an uncertain create with an allocated session ID binds that real session without creating another', async (t) => {
  const fixture = prepareServerComposer(t)
  let creates = 0
  dashboardApi.createAndStartSession = async () => {
    creates += 1
    throw new ApiError({
      status: 409,
      detail: 'Outcome unknown',
      kind: 'http',
      code: 'session_create_outcome_unknown',
      payload: { sessionId: 'server-allocated-session' },
    })
  }
  await mount()
  await act(async () => fixture.sendButton().click())
  assert.equal(creates, 1)
  assert.equal(fixture.failure[2], 'unknown')
  assert.equal(fixture.binding[1].id, 'server-allocated-session')
  assert.equal(fixture.binding[1].connectorId, 'server-agent')
})

for (const result of ['accepted', 'rejected']) {
  test(`a same-account permission version change does not strand an in-flight ${result} create`, async (t) => {
    const fixture = prepareServerComposer(t)
    let finish
    dashboardApi.createAndStartSession = () =>
      new Promise((resolve, reject) => {
        finish = () =>
          result === 'accepted'
            ? resolve({
                session: {
                  ...fixture.optimistic.session,
                  id: 'allocated-session',
                },
                attachments: [],
              })
            : reject(
                new ApiError({
                  status: 403,
                  detail: 'Permission changed',
                  kind: 'forbidden',
                }),
              )
      })
    await mount()
    await act(async () => fixture.sendButton().click())
    assert.equal(workbenchCell('new-session/creating', false).get(), true)
    await unmount()
    const updated = { ...fixture.session, authzVersion: 2 }
    saveStoredSession(updated)
    globalThis.composerAuth = {
      session: updated,
      can: (permission) => updated.permissions.includes(permission),
    }
    await mount()
    await act(async () => finish())
    assert.equal(workbenchCell('new-session/creating', false).get(), false)
    if (result === 'accepted')
      assert.equal(fixture.binding[1].id, 'allocated-session')
    else assert.equal(fixture.failure[2], 'rejected')
  })
}
