import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { JSDOM } from 'jsdom'
import { registerSource } from './helpers/onboarding-source.mjs'

const dom = new JSDOM('<html><body></body></html>', {
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
  'Element',
  'DocumentFragment',
  'Node',
  'NodeFilter',
  'Event',
  'CustomEvent',
  'MutationObserver',
  'getComputedStyle',
])
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: dom.window[name],
  })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const source = registerSource()
const override = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/components/auth/auth-context.tsx'))
      return {
        format: 'module',
        shortCircuit: true,
        source:
          'export const useAuth = () => ({session:{userId:"office-test",authzVersion:1},can:()=>true})',
      }
    return nextLoad(url, context)
  },
})
const { createElement: h, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const { AgentDefinitionPicker } =
  await import('../src/components/agent-definition-picker.tsx')
const { AgentDefinitionEditor } =
  await import('../src/components/management/agent-definition-editor.tsx')
const { stageAgentTrial } = await import('../src/features/agents/trial.ts')
const { workbenchCell } = await import('../src/features/workbench/memory.ts')
const { saveStoredSession, clearStoredSession } =
  await import('../src/features/auth/session.ts')
const example = {
  id: 'office-test-agent',
  name: 'Excel 办公助手',
  description: '处理实际上传资料',
  instructions: '明确输入后确认方案',
  recommendedPrompts: ['检查上传费用并按部门汇总。'],
  inputRequirements: ['CSV/XLSX 文件，说明字段含义。'],
  outputExamples: ['费用汇总.xlsx，含可编辑图表。'],
  knowledgeBaseIds: [],
  knowledgeAssetIds: [],
  templateAssetIds: [],
  skillIds: [],
  toolIds: [],
  published: true,
  version: 1,
}
async function render(component) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () =>
    root.render(
      h(NextIntlClientProvider, { locale: 'zh', messages: {} }, component),
    ),
  )
  return async () => {
    await act(async () => root.unmount())
    container.remove()
  }
}
function login(userId) {
  saveStoredSession({
    userId,
    accessToken: `fixture-${userId}`,
    refreshToken: '',
    roles: ['admin'],
    permissions: ['agents.manage', 'sessions.run'],
    authzVersion: 1,
  })
}
test.after(() => {
  override.deregister()
  source.deregister()
  dom.window.close()
})

test('agent picker shows input/output guidance and suggestion clicks only call the draft callback', async () => {
  const prompts = []
  const dispose = await render(
    h(AgentDefinitionPicker, {
      value: example.id,
      onChange() {},
      items: [example],
      loading: false,
      error: '',
      onRetry() {},
      disabled: false,
      onPrompt: (prompt) => prompts.push(prompt),
    }),
  )
  try {
    assert.match(document.body.textContent, /CSV\/XLSX/u)
    assert.match(document.body.textContent, /费用汇总.xlsx/u)
    const button = [...document.querySelectorAll('button')].find(
      (item) => item.textContent === example.recommendedPrompts[0],
    )
    await act(async () => button.click())
    assert.deepEqual(prompts, example.recommendedPrompts)
  } finally {
    await dispose()
  }
})

test('editor exposes separate recommendation, input and output metadata without requiring optional templates', async () => {
  const dispose = await render(
    h(AgentDefinitionEditor, {
      open: true,
      editing: true,
      draft: example,
      onChange() {},
      onClose() {},
      onSave() {},
      catalog: { assets: [], knowledgeBases: [], skills: [], tools: [] },
      loading: false,
      catalogError: '',
      onRetry() {},
      busy: false,
      error: '',
    }),
  )
  try {
    assert.match(document.body.textContent, /推荐指令（每行一条）/u)
    assert.match(document.body.textContent, /输入要求（每行一条）/u)
    assert.match(document.body.textContent, /输出示例（每行一条）/u)
    assert.match(document.body.textContent, /模板可选/u)
    assert.equal(
      [...document.querySelectorAll('textarea')].some(
        (item) => item.value === example.recommendedPrompts[0],
      ),
      true,
    )
  } finally {
    await dispose()
  }
})

test('real trial protects existing drafts/uploads and does not auto-send', () => {
  login('trial-owner')
  workbenchCell('new-session/prompt', '').set('原草稿')
  assert.equal(stageAgentTrial(example), 'draft')
  assert.equal(workbenchCell('new-session/prompt', '').get(), '原草稿')
  workbenchCell('new-session/prompt', '').set('')
  workbenchCell('new-session/attachments', []).set([{ id: 'attachment' }])
  assert.equal(stageAgentTrial(example), 'draft')
  workbenchCell('new-session/attachments', []).set([])
  assert.equal(stageAgentTrial(example), 'ready')
  assert.equal(workbenchCell('new-session/creating', false).get(), false)
  assert.equal(
    workbenchCell('new-session/agent-definition', '').get(),
    example.id,
  )
  assert.equal(
    workbenchCell('new-session/prompt', '').get(),
    example.recommendedPrompts[0],
  )
  assert.equal(window.location.hash, '#/workspace')
  clearStoredSession()
})

test('trial intent is cleared on account switch and unpublished/inflight agents cannot launch', () => {
  login('first-owner')
  workbenchCell('new-session/agent-trial', '').set('first-agent')
  login('second-owner')
  assert.equal(workbenchCell('new-session/agent-trial', '').get(), '')
  assert.equal(stageAgentTrial({ ...example, published: false }), 'unpublished')
  workbenchCell('new-session/creating', false).set(true)
  assert.equal(stageAgentTrial(example), 'busy')
  clearStoredSession()
})
