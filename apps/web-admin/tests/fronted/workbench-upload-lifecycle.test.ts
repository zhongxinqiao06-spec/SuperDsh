import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createPinia } from 'pinia'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { useWorkbench } from '@/composables/workbench/use-workbench'
import { useDraftStore } from '@/store/modules/draft-store'
import type {
  UploadedAttachment,
  WorkspaceSession,
} from '@/types/workbench/models'

const mocks = vi.hoisted(() => ({
  generation: 0,
  listeners: new Set<() => void>(),
  upload: vi.fn(),
  create: vi.fn(),
  message: vi.fn(),
  sessions: vi.fn(),
  canRead: false,
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/workspace' }),
  useRouter: () => ({ replace: vi.fn() }),
}))
vi.mock('element-plus', () => ({ ElMessageBox: {} }))
vi.mock('@/store/modules/auth-store', () => ({
  useAuthStore: () => ({
    can: (permission: string) =>
      ['sessions.run', 'models.use'].includes(permission) ||
      (mocks.canRead && permission === 'sessions.read'),
  }),
}))
vi.mock('@/store/session-controller', () => ({
  sessionController: {
    get generation() {
      return mocks.generation
    },
    subscribe: (callback: () => void) => {
      mocks.listeners.add(callback)
      return () => mocks.listeners.delete(callback)
    },
  },
}))
vi.mock('@/store/modules/runtime-store', () => ({
  useRuntimeStore: () => ({
    agent: {
      status: 'running',
      connectorId: 'native',
      projectId: 'managed',
      runtimeId: 'dsh',
      error: null,
    },
    prepare: async () => {},
    refresh: async () => {},
  }),
}))
vi.mock('@/composables/workbench/use-session-stream', () => ({
  useSessionStream: () => ({
    disconnect: () => {},
    connect: async () => {},
    status: 'connected',
  }),
}))
vi.mock('@/composables/workbench/use-runtime-selections', () => ({
  useRuntimeSelections: () => ({
    modelUnavailable: { value: false },
    modelId: { value: '' },
    reasoningId: { value: '' },
    permissionId: { value: '' },
  }),
}))
vi.mock('@/api/files/upload-api', () => ({ uploadFile: mocks.upload }))
vi.mock('@/api/workbench/conversation-api', () => ({
  conversationApi: {
    agents: async () => ({ items: [] }),
    create: mocks.create,
    send: mocks.message,
    sessions: mocks.sessions,
  },
}))

let wrapper: VueWrapper | undefined
beforeEach(() => {
  mocks.generation = 0
  mocks.listeners.clear()
  mocks.upload.mockReset()
  mocks.create.mockReset()
  mocks.message.mockReset()
  mocks.canRead = false
  mocks.sessions
    .mockReset()
    .mockResolvedValue({ sessions: [], nextCursor: null })
})

/** 同一实际工作台用例验证分页期间的增量状态，第一百零一条不能被首屏限制吞掉。 */
describe('工作台列表分页生命周期', () => {
  it('首100条之后按nextCursor加载第101条并去重，末页不重复请求', async () => {
    mocks.canRead = true
    const rows: WorkspaceSession[] = Array.from(
      { length: 101 },
      (_, index) => ({
        id: `session-${index}`,
        connectorId: 'native',
        projectId: 'managed',
        runtimeId: 'dsh',
        runtime: 'dsh',
        title: `会话${index}`,
        cwd: '/synthetic',
        status: 'idle',
        pinned: false,
        archived: false,
        takeover: true,
        unread: false,
        updatedSeq: 1,
        agentDefinition: null,
      }),
    )
    mocks.sessions.mockImplementation(async (query: Record<string, string>) =>
      query.cursor === 'cursor-100'
        ? { sessions: rows.slice(99), nextCursor: null }
        : { sessions: rows.slice(0, 100), nextCursor: 'cursor-100' },
    )
    let vm!: ReturnType<typeof useWorkbench>
    wrapper = mount(
      defineComponent({
        setup() {
          vm = useWorkbench()
          return () => h('div')
        },
      }),
      { global: { plugins: [createPinia()] } },
    )
    await flushPromises()
    expect(vm.sessions.value).toHaveLength(100)
    expect(vm.nextCursor.value).toBe('cursor-100')
    await vm.moreSessions()
    expect(mocks.sessions).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'cursor-100', archived: 'false' }),
      expect.any(AbortSignal),
    )
    expect(vm.sessions.value.map((item) => item.id)).toEqual(
      rows.map((item) => item.id),
    )
    expect(vm.nextCursor.value).toBeNull()
    const calls = mocks.sessions.mock.calls.length
    await vm.moreSessions()
    expect(mocks.sessions).toHaveBeenCalledTimes(calls)
  })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

/** 上传器故意忽略取消并迟到成功，验证用例层仍守住身份、卸载和草稿边界。 */
describe('上传后的任务提交资格', () => {
  for (const existing of [false, true])
    for (const invalidate of ['identity', 'dispose'] as const) {
      it(`${existing ? '已有会话' : '新会话'} 上传期间${invalidate === 'identity' ? '换账号' : '卸载'}后不提交旧任务`, async () => {
        const pinia = createPinia()
        let vm!: ReturnType<typeof useWorkbench>
        wrapper = mount(
          defineComponent({
            setup() {
              vm = useWorkbench()
              return () => h('div')
            },
          }),
          { global: { plugins: [pinia] } },
        )
        await flushPromises()
        if (existing) vm.selected.value = 'existing-session'
        const current = vm.draft.value
        current.text = '旧账号合成任务'
        current.files = [
          new File(['synthetic'], 'sample.txt', { type: 'text/plain' }),
        ]
        let complete!: (value: UploadedAttachment) => void
        mocks.upload.mockImplementation(
          () =>
            new Promise<UploadedAttachment>((resolve) => {
              complete = resolve
            }),
        )
        const sending = vm.send()
        await flushPromises()
        expect(mocks.upload).toHaveBeenCalledOnce()
        const oldSubmission = current.submission!
        if (invalidate === 'identity') {
          mocks.generation++
          useDraftStore(pinia).bind(mocks.generation)
          for (const callback of mocks.listeners) callback()
          vm.draft.value.text = '新账号自己的草稿'
        } else {
          wrapper.unmount()
          wrapper = undefined
        }
        complete({
          fileId: 'synthetic-upload',
          name: 'sample.txt',
          mediaType: 'text/plain',
          size: 9,
          sha256: 'synthetic',
        })
        await sending
        expect(mocks.create).not.toHaveBeenCalled()
        expect(mocks.message).not.toHaveBeenCalled()
        expect(oldSubmission.attachments).toEqual([])
        expect(current.text).toBe('旧账号合成任务')
        expect(current.files).toHaveLength(1)
        if (invalidate === 'identity')
          expect(vm.draft.value.text).toBe('新账号自己的草稿')
      })
    }
})
