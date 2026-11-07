import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { JSDOM } from 'jsdom'
import { registerSource } from './helpers/onboarding-source.mjs'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://fixture.example/#/agents',
  pretendToBeVisual: true,
})
for (const name of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'HTMLButtonElement',
  'HTMLFormElement',
  'Element',
  'DocumentFragment',
  'Node',
  'NodeFilter',
  'Event',
  'CustomEvent',
  'MutationObserver',
  'getComputedStyle',
  'FileReader',
])
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: dom.window[name],
  })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const source = registerSource()
const override = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/components/management/agent-pdf-preview.tsx'))
      return {
        format: 'module',
        shortCircuit: true,
        source: `import {createElement} from 'react'; export function AgentPdfPreview(props) { globalThis.officePreviewProps = props; return createElement('div', {'data-office-preview':true}, props.name) }`,
      }
    if (url.endsWith('/components/auth/auth-context.tsx'))
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export const useAuth = () => globalThis.agentsAuth',
      }
    return nextLoad(url, context)
  },
})
const { AgentsPanel } =
  await import('../src/components/management/agents-panel.tsx')
const { KnowledgeBasesPanel } =
  await import('../src/components/management/knowledge-bases-panel.tsx')
const { SkillsPanel } =
  await import('../src/components/management/skills-panel.tsx')
const { ToolsPanel } =
  await import('../src/components/management/tools-panel.tsx')
const { knowledgeBasesApi, agentSkillsApi, agentToolsApi } =
  await import('../src/features/agents/resources-api.ts')
const { extensionsApi } =
  await import('../src/features/agents/extensions-api.ts')
const { AgentSessionArtifacts } =
  await import('../src/components/session/agent-session-artifacts.tsx')
const { agentsApi } = await import('../src/features/agents/api.ts')
const { saveStoredSession, clearStoredSession } =
  await import('../src/features/auth/session.ts')
test.after(() => {
  override.deregister()
  source.deregister()
  dom.window.close()
})
const agent = {
  id: 'agent-1',
  name: '销售分析助手',
  description: '按模板输出销售分析',
  instructions: '从提供的数据回答，不编造。',
  knowledgeBaseIds: ['kb-1'],
  knowledgeAssetIds: ['knowledge'],
  templateAssetIds: [],
  skillIds: ['sales-analysis'],
  toolIds: ['knowledge_search'],
  published: true,
  version: 2,
  createdAt: '2026-10-15T10:00:00Z',
  updatedAt: '2026-10-15T10:00:00Z',
}
const knowledge = {
  id: 'knowledge',
  name: '示例销售.csv',
  kind: 'knowledge',
  size: 100,
  preview: '季度,销售额\n一季度,100',
  sha256: 'fixture-hash',
  createdAt: agent.createdAt,
}
const catalog = {
  knowledgeBases: [
    {
      id: 'kb-1',
      name: '公司销售资料',
      description: '销售知识和模板',
      enabled: true,
      version: 1,
      assetIds: ['knowledge'],
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    },
  ],
  assets: [
    knowledge,
    {
      ...knowledge,
      id: 'template',
      name: '销售模板.xlsx',
      kind: 'spreadsheet-template',
    },
  ],
  skills: [
    {
      id: 'sales-analysis',
      name: '销售分析',
      description: '核对销售数据与趋势',
      instructions: '校验销售额，再计算同比和环比。',
      requiredToolIds: ['knowledge_search'],
      enabled: true,
      version: 1,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    },
  ],
  tools: [
    {
      id: 'knowledge_search',
      name: '知识检索',
      description: '检索已绑定资料',
      enabled: true,
      version: 1,
      settings: { maxResults: 8 },
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    },
  ],
}
let root
let container
function setup() {
  const session = {
    userId: 'admin-fixture',
    accessToken: 'fixture-token',
    roles: ['admin'],
    permissions: ['agents.manage'],
    authzVersion: 1,
  }
  saveStoredSession(session)
  globalThis.agentsAuth = {
    session,
    can: (permission) => session.permissions.includes(permission),
  }
  agentsApi.list = async () => ({ items: [agent], total: 1 })
  agentsApi.catalog = async () => catalog
  agentsApi.save = async () => ({ agent })
  agentsApi.remove = async () => undefined
  agentsApi.seedDemo = async () => ({ agents: [agent], assets: catalog.assets })
  agentsApi.officePlans = async () => ({ items: [] })
  agentsApi.evidence = async () => ({ items: [] })
  knowledgeBasesApi.list = async () => ({
    items: catalog.knowledgeBases,
    total: 1,
    page: 1,
    pageSize: 10,
  })
  knowledgeBasesApi.save = async () => ({
    knowledgeBase: catalog.knowledgeBases[0],
  })
  knowledgeBasesApi.searchStatus = async () => ({
    engine: 'qdrant',
    ready: true,
    message: '检索服务已就绪',
  })
  knowledgeBasesApi.index = async () => ({ indexedAssets: 1, chunks: 3 })
  agentSkillsApi.list = async () => ({
    items: catalog.skills,
    total: 1,
    page: 1,
    pageSize: 10,
  })
  agentSkillsApi.save = async () => ({ skill: catalog.skills[0] })
  agentToolsApi.list = async () => ({
    items: catalog.tools,
    total: 1,
    page: 1,
    pageSize: 10,
  })
  agentToolsApi.save = async () => ({ tool: catalog.tools[0] })
  extensionsApi.list = async () => ({
    items: [
      {
        id: 'superdsh.builtin',
        name: '内置办公工具',
        enabled: true,
        activeVersion: '1.0.0',
        revision: 1,
        versions: [{ version: '1.0.0', digest: 'fixture' }],
        tools: [
          {
            id: 'knowledge_search',
            name: '知识检索',
            description: '检索已绑定资料',
            permissions: ['sessions.read'],
            timeoutSeconds: 30,
            configurationSchema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                maxResults: {
                  type: 'integer',
                  minimum: 1,
                  maximum: 20,
                  title: '最大结果数',
                },
              },
            },
          },
        ],
      },
    ],
  })
}
async function render(component = AgentsPanel, props = {}) {
  if (!root) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  }
  await act(async () =>
    root.render(
      h(
        NextIntlClientProvider,
        { locale: 'zh-CN', messages: {} },
        h(component, props),
      ),
    ),
  )
}
const button = (text, scope = document) =>
  [...scope.querySelectorAll('button')].find(
    (item) => item.textContent === text,
  )
async function click(text, scope) {
  const found = button(text, scope)
  assert.ok(found, `button ${text}`)
  await act(async () => found.click())
}
async function change(input, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(input),
      'value',
    ).set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
test.afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container?.remove()
  clearStoredSession()
})

test('agent management uses real modal editing, retains configuration on API failure and saves only after explicit retry', async () => {
  setup()
  let attempt = 0
  let saved
  agentsApi.save = async (id, body) => {
    attempt++
    saved = { id, body }
    if (attempt === 1) throw new Error('Version changed, review and retry')
    return { agent }
  }
  await render()
  await click('编辑')
  let dialog = document.querySelector('[role="dialog"]')
  assert.ok(dialog)
  assert.match(dialog.textContent, /模型沿用工作台会话/)
  await change(
    dialog.querySelector('input:not([type="checkbox"])'),
    '更新后的销售助手',
  )
  const base = [...dialog.querySelectorAll('label')]
    .find((label) => label.textContent.includes('公司销售资料'))
    .querySelector('input')
  assert.equal(base.checked, true)
  assert.equal(dialog.textContent.includes('销售模板.xlsx'), false)
  await click('保存', dialog)
  assert.equal(attempt, 1)
  assert.match(dialog.textContent, /Version changed/)
  assert.equal(
    dialog.querySelector('input:not([type="checkbox"])').value,
    '更新后的销售助手',
  )
  await click('保存', dialog)
  assert.equal(attempt, 2)
  assert.equal(saved.id, agent.id)
  assert.equal(saved.body.name, '更新后的销售助手')
  assert.deepEqual(saved.body.knowledgeBaseIds, ['kb-1'])
  assert.deepEqual(saved.body.knowledgeAssetIds, ['knowledge'])
  assert.deepEqual(saved.body.templateAssetIds, [])
  assert.equal(saved.body.version, 2)
  assert.equal(document.querySelector('[role="dialog"]'), null)
})

test('agent list search and pagination issue scoped backend queries instead of slicing the first page', async () => {
  setup()
  const calls = []
  agentsApi.list = async (...args) => {
    calls.push(args)
    return { items: [{ ...agent, id: `page-${args[0]}` }], total: 51 }
  }
  await render()
  await click('下一页')
  assert.deepEqual(calls.at(-1), [2, 10, ''])
  await change(
    container.querySelector('input[aria-label="搜索智能体"]'),
    '销售',
  )
  await click('搜索')
  assert.deepEqual(calls.at(-1), [1, 10, '销售'])
})

test('agent deletion requires confirmation; examples are not hidden behind a manual initialization action', async () => {
  setup()
  let removals = 0
  agentsApi.remove = async () => {
    removals++
    throw new Error('Agent is in use')
  }
  await render()
  await click('删除')
  assert.equal(removals, 0)
  await click('删除', document.querySelector('[role="dialog"]'))
  assert.equal(removals, 1)
  assert.match(
    document.querySelector('[role="dialog"]').textContent,
    /Agent is in use/,
  )
  await click('取消', document.querySelector('[role="dialog"]'))
  assert.equal(button('初始化演示内容'), undefined)
  assert.equal(button('资料与模板'), undefined)
})

test('users without agents.manage do not fetch configuration or expose editor actions', async () => {
  setup()
  globalThis.agentsAuth.can = () => false
  agentsApi.list = async () => assert.fail('must not load management list')
  agentsApi.catalog = async () =>
    assert.fail('must not load management catalog')
  await render()
  assert.match(container.textContent, /没有智能体管理权限/)
  assert.equal(button('新增智能体'), undefined)
})

test('knowledge base files upload to the selected collection and rebuild its search index', async () => {
  setup()
  let uploaded
  let catalogs = 0
  let saved
  let indexed
  agentsApi.catalog = async () => {
    catalogs++
    return catalog
  }
  agentsApi.upload = async (body) => {
    uploaded = body
    return { asset: knowledge }
  }
  knowledgeBasesApi.save = async (id, body) => {
    saved = { id, body }
    return { knowledgeBase: catalog.knowledgeBases[0] }
  }
  knowledgeBasesApi.index = async (id) => {
    indexed = id
    return { indexedAssets: 1, chunks: 3 }
  }
  await render(KnowledgeBasesPanel)
  assert.match(container.textContent, /Qdrant/)
  await click('管理文件')
  await click('上传资料或模板')
  const dialog = [...document.querySelectorAll('[role="dialog"]')].find(
    (item) => item.querySelector('input[type="file"]'),
  )
  const input = dialog.querySelector('input[type="file"]')
  const file = new dom.window.File(['name,sales\nA,100'], 'sales.csv', {
    type: 'text/csv',
  })
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  await act(async () =>
    input.dispatchEvent(new Event('change', { bubbles: true })),
  )
  await act(async () => {
    dialog
      .querySelector('form')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    const deadline = Date.now() + 5000
    while (!uploaded && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20))
  })
  assert.equal(uploaded.kind, 'knowledge')
  assert.equal(uploaded.name, 'sales.csv')
  assert.equal(
    Buffer.from(uploaded.contentBase64, 'base64').toString(),
    'name,sales\nA,100',
  )
  assert.ok(catalogs >= 3)
  assert.equal(saved.id, 'kb-1')
  assert.equal(saved.body.version, 1)
  assert.deepEqual(saved.body.assetIds, ['knowledge'])
  assert.equal(indexed, 'kb-1')
  assert.equal(document.querySelector('input[type="file"]'), null)
  assert.match(
    document.querySelector('[role="dialog"]').textContent,
    /公司销售资料/,
  )
})

test('skill editor persists reusable instructions and required tool IDs independently', async () => {
  setup()
  let saved
  agentSkillsApi.save = async (id, body) => {
    saved = { id, body }
    return { skill: catalog.skills[0] }
  }
  await render(SkillsPanel)
  await click('编辑')
  const dialog = document.querySelector('[role="dialog"]')
  const instruction = [...dialog.querySelectorAll('label')]
    .find((item) => item.textContent.includes('执行要求'))
    .querySelector('textarea')
  await change(instruction, '先核对数据来源，再生成经营分析并列出风险。')
  await click('保存', dialog)
  assert.equal(saved.id, 'sales-analysis')
  assert.equal(
    saved.body.instructions,
    '先核对数据来源，再生成经营分析并列出风险。',
  )
  assert.deepEqual(saved.body.requiredToolIds, ['knowledge_search'])
  assert.equal(saved.body.version, 1)
  assert.equal(document.querySelector('[role="dialog"]'), null)
})

test('skill flow editor saves editable stages as a draft with required tool dependencies', async () => {
  setup()
  let saved
  agentSkillsApi.save = async (id, body) => {
    saved = { id, body }
    return { skill: catalog.skills[0] }
  }
  await render(SkillsPanel)
  await click('编辑')
  const dialog = document.querySelector('[role="dialog"]')
  await click('使用 PPT 流程起点', dialog)
  const fields = [...dialog.querySelectorAll('label')]
  const matching = fields
    .find((item) => item.textContent.includes('匹配词'))
    .querySelector('textarea')
  await change(matching, '客户演示\nPPT\n')
  const stageName = fields
    .find((item) => item.textContent.includes('阶段名称'))
    .querySelector('input')
  await change(stageName, '公司资料与权限检查')
  await click('保存', dialog)
  assert.equal(
    saved.body.program,
    undefined,
    'saving must not silently publish',
  )
  assert.equal(saved.body.programDraft.stages.length, 6)
  assert.equal(saved.body.programDraft.stages[0].name, '公司资料与权限检查')
  assert.deepEqual(saved.body.programDraft.match.phrases, [
    '客户演示',
    'PPT',
    '',
  ])
  assert.ok(saved.body.requiredToolIds.includes('presentation_report'))
  assert.deepEqual(saved.body.programDraft.stages.at(-1).checks, [
    'schema',
    'artifact',
    'rendered-quality',
  ])
})

test('tool settings persist separately and only expose approved implementations', async () => {
  setup()
  let saved
  agentToolsApi.save = async (id, body) => {
    saved = { id, body }
    return { tool: catalog.tools[0] }
  }
  await render(ToolsPanel)
  assert.ok(button('新增工具'))
  await click('编辑')
  const dialog = document.querySelector('[role="dialog"]')
  await change(dialog.querySelector('input[type="number"]'), '3')
  await click('保存', dialog)
  assert.equal(saved.id, 'knowledge_search')
  assert.deepEqual(saved.body.settings, { maxResults: 3 })
  assert.equal(saved.body.version, 1)
})

test('search failure keeps knowledge management usable and retries the failed index operation', async () => {
  setup()
  let attempts = 0
  knowledgeBasesApi.searchStatus = async () => ({
    engine: 'qdrant',
    ready: false,
    message: 'Qdrant unavailable',
  })
  knowledgeBasesApi.index = async (id) => {
    assert.equal(id, 'kb-1')
    attempts++
    if (attempts === 1) throw new Error('Qdrant unavailable')
    return { indexedAssets: 1, chunks: 3 }
  }
  await render(KnowledgeBasesPanel)
  assert.ok(button('新增知识库'))
  assert.match(container.textContent, /公司销售资料/)
  await click('重建索引')
  assert.equal(attempts, 1)
  assert.match(container.textContent, /检索索引更新失败/)
  await click('重试')
  assert.equal(attempts, 2)
  assert.match(container.textContent, /已索引 1 份资料、3 个内容段落/)
  assert.doesNotMatch(container.textContent, /检索索引更新失败/)
})

test('session outputs refresh when execution becomes idle and stale account downloads never save a file', async (t) => {
  setup()
  const calls = []
  const artifact = {
    fileId: 'output-1',
    name: '销售分析.xlsx',
    size: 120,
    mediaType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    createdAt: agent.createdAt,
  }
  agentsApi.artifacts = async (id) => {
    calls.push(id)
    return {
      agentDefinition: { id: agent.id, name: agent.name, version: 2 },
      items: calls.length === 1 ? [] : [artifact],
    }
  }
  let release
  agentsApi.downloadArtifact = async (id, fileId) => {
    assert.equal(id, 'session-a')
    assert.equal(fileId, artifact.fileId)
    return new Promise((resolve) => {
      release = resolve
    })
  }
  let saved = 0
  t.mock.method(URL, 'createObjectURL', () => {
    saved++
    return 'blob:fixture'
  })
  await render(AgentSessionArtifacts, {
    sessionId: 'session-a',
    status: 'running',
  })
  assert.match(container.textContent, /尚未生成文件/)
  await render(AgentSessionArtifacts, {
    sessionId: 'session-a',
    status: 'idle',
  })
  assert.deepEqual(calls, ['session-a', 'session-a'])
  assert.match(container.textContent, /销售分析.xlsx/)
  await click('下载')
  await act(async () => {
    clearStoredSession()
    release({
      name: artifact.name,
      mediaType: artifact.mediaType,
      contentBase64: 'Zml4dHVyZQ==',
    })
  })
  assert.equal(saved, 0)
})

test('office session displays scoped plans and source evidence without automatically previewing or approving', async () => {
  setup()
  const calls = []
  agentsApi.artifacts = async () => ({
    agentDefinition: { id: agent.id, name: agent.name, version: 2 },
    items: [
      {
        fileId: 'ppt-1',
        name: '公司介绍.pptx',
        size: 1024,
        revision: { planVersion: 3, previousArtifactId: 'ppt-old' },
        preview: { state: 'failed', missingFonts: [] },
        diagnostics: ['预览验证失败，可编辑文件已保留'],
      },
    ],
  })
  agentsApi.officePlans = async (id) => {
    calls.push(['plans', id])
    return {
      items: [
        {
          id: 'plan-1',
          title: '公司介绍',
          version: 3,
          state: 'prepared',
          summary: '## 页面安排\n\n公司介绍、服务范围',
          warnings: ['保留模板字体'],
          sources: [
            {
              id: 'source-1',
              name: '公司制度.pdf',
              sha256: 'verified-source-hash',
            },
          ],
        },
      ],
    }
  }
  agentsApi.evidence = async (id) => {
    calls.push(['evidence', id])
    return {
      items: [
        {
          id: 'evidence-1',
          sourceId: 'ref-1',
          filename: '公司制度.pdf',
          content: '报销应由部门负责人审批。',
          sha256: 'verified-source-hash',
          location: { page: 4 },
        },
      ],
    }
  }
  let previewCalls = 0
  agentsApi.previewArtifact = async () => {
    previewCalls++
    throw new Error('must be explicit')
  }
  await render(AgentSessionArtifacts, {
    sessionId: 'office-session',
    status: 'waiting_input',
  })
  assert.deepEqual(calls, [
    ['plans', 'office-session'],
    ['evidence', 'office-session'],
  ])
  assert.match(container.textContent, /方案 v3 · 修订成果/u)
  assert.match(container.textContent, /预览验证失败，可编辑文件已保留/u)
  assert.ok(button('重试预览'))
  assert.match(container.textContent, /等待方案确认/u)
  assert.match(container.textContent, /报销应由部门负责人审批/u)
  assert.match(container.textContent, /页 4/u)
  assert.equal(previewCalls, 0)
  assert.equal(button('确认生成'), undefined)
})

test('office preview fetches authorized bytes on demand and closes on account loss', async () => {
  setup()
  const file = { fileId: 'office-file', name: '培训.pptx', size: 1024 }
  agentsApi.artifacts = async () => ({
    agentDefinition: { id: agent.id, name: agent.name, version: 2 },
    items: [file],
  })
  const calls = []
  agentsApi.previewArtifact = async (...args) => {
    calls.push(args)
    return {
      name: '培训.pdf',
      mediaType: 'application/pdf',
      contentBase64: 'JVBERi0xLjcK',
    }
  }
  await render(AgentSessionArtifacts, {
    sessionId: 'preview-session',
    status: 'idle',
  })
  await click('预览')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].slice(0, 2), ['preview-session', 'office-file'])
  assert.equal(calls[0][2].aborted, false)
  assert.ok(document.querySelector('[data-office-preview]'))
  await act(async () => clearStoredSession())
  assert.equal(document.querySelector('[data-office-preview]'), null)
  assert.equal(calls[0][2].aborted, true)
})

test('late preview response cannot appear in the next conversation', async () => {
  setup()
  agentsApi.artifacts = async () => ({
    agentDefinition: { id: agent.id, name: agent.name, version: 2 },
    items: [{ fileId: 'old-file', name: '旧方案.pptx', size: 1024 }],
  })
  let release
  let signal
  agentsApi.previewArtifact = async (_session, _file, stopped) => {
    signal = stopped
    return new Promise((resolve) => {
      release = resolve
    })
  }
  await render(AgentSessionArtifacts, {
    sessionId: 'old-session',
    status: 'idle',
  })
  await click('预览')
  await render(AgentSessionArtifacts, {
    sessionId: 'new-session',
    status: 'idle',
  })
  assert.equal(signal.aborted, true)
  await act(async () =>
    release({
      name: '旧方案.pdf',
      mediaType: 'application/pdf',
      contentBase64: 'JVBERi0xLjcK',
    }),
  )
  assert.equal(document.querySelector('[data-office-preview]'), null)
  assert.equal(document.querySelector('[role="dialog"]'), null)
})

test('structured artwork uses the authenticated PNG preview and clears on signout', async () => {
  setup()
  agentsApi.artifacts = async () => ({
    agentDefinition: { id: agent.id, name: agent.name, version: 1 },
    items: [{ fileId: 'artwork', name: '配图.png', size: 1200 }],
  })
  agentsApi.previewArtifact = async (session, file) => {
    assert.equal(session, 'graphics-session')
    assert.equal(file, 'artwork')
    return {
      name: '配图.png',
      mediaType: 'image/png',
      contentBase64: 'iVBORw0KGgo=',
    }
  }
  await render(AgentSessionArtifacts, {
    sessionId: 'graphics-session',
    status: 'idle',
  })
  await click('预览')
  assert.equal(
    document.querySelector('img[alt="配图.png"]')?.getAttribute('src'),
    'data:image/png;base64,iVBORw0KGgo=',
  )
  await act(async () => clearStoredSession())
  assert.equal(document.querySelector('img[alt="配图.png"]'), null)
})
