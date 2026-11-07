import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { createRequire } from 'node:module'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PlatformWorkspaceModel } from '../src/features/platform/use-platform-workspace.ts'
import type { Request } from '../src/features/platform/platform-model.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: Record<string, unknown>) =>
    React.createElement('button', props, children as React.ReactNode),
  Input: (props: Record<string, unknown>) =>
    React.createElement('input', props),
  Checkbox: () => null,
  MarkdownText: ({ text }: { text: string }) =>
    React.createElement('div', { 'data-markdown': true }, text),
}))
vi.mock('../src/features/platform/AgentPdfPreview.tsx', () => ({
  AgentPdfPreview: () =>
    React.createElement('div', { 'data-preview': true }, 'PDF preview'),
}))
import { NoticePrompt } from '../src/features/platform/NoticePrompt.tsx'
import { AgentArtifacts } from '../src/features/platform/AgentArtifacts.tsx'
import { SkillRuns } from '../src/features/platform/SkillRuns.tsx'

const requireAdmin = createRequire(
  new URL('../../../admin/package.json', import.meta.url),
)
const { JSDOM } = requireAdmin('jsdom') as {
  JSDOM: new (
    html: string,
    options: object,
  ) => { window: Window & typeof globalThis }
}
let dom: InstanceType<typeof JSDOM>
let root: Root | undefined
let container: HTMLDivElement
const oldGlobals = new Map<string, PropertyDescriptor | undefined>()
beforeAll(() => {
  dom = new JSDOM('<!doctype html><body></body>', {
    url: 'https://fixture.invalid',
    pretendToBeVisual: true,
  })
  for (const key of [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLInputElement',
    'Event',
    'MouseEvent',
    'IS_REACT_ACT_ENVIRONMENT',
  ]) {
    oldGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value:
        key === 'IS_REACT_ACT_ENVIRONMENT'
          ? true
          : Reflect.get(dom.window, key),
    })
  }
})
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  container?.remove()
})
afterAll(() => {
  dom.window.close()
  for (const [key, descriptor] of oldGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})
async function render(element: React.ReactElement) {
  if (!root) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  }
  await act(async () => root!.render(element))
}
const button = (name: string) =>
  Array.from(container.querySelectorAll('button')).find(
    (item) => item.textContent === name,
  )!

describe('desktop office session', () => {
  it('shows the server stage evidence and replaces it when the session changes', async () => {
    await render(
      React.createElement(SkillRuns, {
        items: [
          {
            id: 'run-1',
            skillName: '文档技能',
            skillVersion: 2,
            state: 'needs-revision',
            selection: { reason: 'Word 文档请求' },
            stages: [
              {
                id: 'review',
                name: '最终校验',
                state: 'needs-revision',
                skillId: 'quality',
                skillVersion: 1,
                attempt: 2,
                checks: [{ passed: false, message: '第 2 页渲染溢出' }],
                calls: [
                  {
                    tool: 'document_report',
                    phase: 'execute',
                    state: 'completed',
                  },
                ],
              },
            ],
          },
        ],
      }),
    )
    expect(container.textContent).toContain('第 2 页渲染溢出')
    expect(container.textContent).toContain('document_report')
    await render(React.createElement(SkillRuns, { items: [] }))
    expect(container.textContent).not.toContain('第 2 页')
  })
  it('previews authenticated diagram bytes without opening an external image URL', async () => {
    const request = vi.fn<Request>().mockResolvedValue({
      name: '配图.png',
      mediaType: 'image/png',
      contentBase64: 'iVBORw0KGgo=',
    })
    const model = {
      sessionId: 'diagram-session',
      request,
      artifacts: {
        skillRuns: [],
        loading: false,
        items: [{ fileId: 'diagram', name: '配图.png' }],
        plans: [],
        evidence: [],
        refresh() {},
      },
    } as unknown as PlatformWorkspaceModel
    await render(React.createElement(AgentArtifacts, { model }))
    await act(async () => button('预览').click())
    expect(request).toHaveBeenCalledWith({
      operation: 'agent-artifact-preview',
      sessionId: 'diagram-session',
      attachmentId: 'diagram',
    })
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,iVBORw0KGgo=',
    )
    await render(
      React.createElement(AgentArtifacts, {
        model: { ...model, sessionId: 'other-session' },
      }),
    )
    expect(container.querySelector('img')).toBeNull()
  })
  it('preserves plan markdown and requires an explicit approval choice', async () => {
    const request = vi.fn<Request>().mockResolvedValue({})
    const run = async (task: () => Promise<void>) => task()
    const notice = {
      noticeId: 'office-review',
      title: '办公方案确认',
      actions: [
        {
          actionId: 'submit',
          label: '提交选择',
          style: 'primary',
          input: {
            required: true,
            uiSchema: {
              component: 'inputRequest',
              questions: [
                {
                  id: 'plan',
                  prompt: '是否生成？\n\n## 页面安排\n\n公司介绍',
                  detail: '依据：企业资料.pdf',
                  intent: { kind: 'plan-review', approveOptionId: 'yes' },
                  options: [
                    { id: 'yes', label: '确认生成' },
                    { id: 'no', label: '修改方案' },
                  ],
                },
              ],
            },
          },
        },
      ],
    }
    await render(
      React.createElement(NoticePrompt, {
        notice,
        sessionId: 'session-a',
        disabled: false,
        request,
        run,
        refresh: async () => {},
      }),
    )
    expect(request).not.toHaveBeenCalled()
    expect(container.querySelector('[data-plan-review]')).not.toBeNull()
    expect(container.textContent).toContain('## 页面安排')
    expect(button('确认生成').getAttribute('aria-pressed')).toBe('false')
    await act(async () => button('确认生成').click())
    expect(request).not.toHaveBeenCalled()
    await act(async () => button('提交选择').click())
    expect(request).toHaveBeenCalledWith({
      operation: 'respond',
      sessionId: 'session-a',
      noticeId: 'office-review',
      body: {
        actionId: 'submit',
        input: { answers: { plan: { optionIds: ['yes'], customText: '' } } },
      },
    })
  })

  it('shows artifact revisions and evidence but drops an old session preview response', async () => {
    let resolvePreview: (value: object) => void = () => {}
    const request = vi.fn<Request>().mockImplementation(
      async () =>
        new Promise((resolve) => {
          resolvePreview = (value) =>
            resolve(value as Awaited<ReturnType<Request>>)
        }),
    )
    const model = {
      sessionId: 'old-session',
      request,
      busy: false,
      run: async (task: () => Promise<void>) => task(),
      downloadAttachment: async () => ({}),
      artifacts: {
        loading: false,
        error: '',
        refresh() {},
        items: [
          {
            fileId: 'file-old',
            name: '公司介绍.pptx',
            revision: { planVersion: 2, previousArtifactId: 'parent' },
            preview: { state: 'failed' },
            diagnostics: ['预览验证失败，可编辑文件已保留'],
          },
        ],
        plans: [
          {
            id: 'plan',
            title: '介绍',
            version: 2,
            state: 'prepared',
            summary: '## 方案',
          },
        ],
        evidence: [
          {
            id: 'evidence',
            filename: '公司制度.pdf',
            sourceId: 'source',
            sha256: 'hash',
            content: '真实资料摘录',
            location: { page: 5 },
          },
        ],
      },
    } as unknown as PlatformWorkspaceModel
    await render(React.createElement(AgentArtifacts, { model }))
    expect(container.textContent).toContain('方案 v2 · 修订成果')
    expect(container.textContent).toContain('真实资料摘录')
    expect(container.textContent).toContain('第 5 页')
    expect(container.textContent).toContain('预览验证失败，可编辑文件已保留')
    await act(async () => button('重试预览').click())
    expect(request).toHaveBeenCalledWith({
      operation: 'agent-artifact-preview',
      sessionId: 'old-session',
      attachmentId: 'file-old',
    })
    await render(
      React.createElement(AgentArtifacts, {
        model: {
          ...model,
          sessionId: 'next-session',
          request: vi.fn<Request>().mockResolvedValue({}),
        },
      }),
    )
    await act(async () =>
      resolvePreview({
        mediaType: 'application/pdf',
        contentBase64: 'JVBERi0xLjcK',
        name: '旧预览.pdf',
      }),
    )
    expect(container.querySelector('[data-preview]')).toBeNull()
    expect(container.textContent).not.toContain('旧预览.pdf')
  })
})
