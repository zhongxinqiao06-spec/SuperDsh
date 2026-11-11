import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, reactive, ref } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { useProjectManager } from '@/composables/workbench/use-project-manager'
import type {
  WorkspaceConnector,
  WorkspaceProject,
} from '@/types/workbench/models'

const mocks = vi.hoisted(() => ({
  identity: { generation: 0 },
  directory: vi.fn(),
  save: vi.fn(),
  confirm: vi.fn(),
  inventory: vi.fn(),
  read: vi.fn(),
}))
vi.mock('element-plus', () => ({ ElMessageBox: { confirm: mocks.confirm } }))
vi.mock('@/store/session-controller', () => ({
  sessionController: {
    get generation() {
      return mocks.identity.generation
    },
  },
}))
vi.mock('@/store/modules/auth-store', () => ({
  useAuthStore: () => ({
    get generation() {
      return mocks.identity.generation
    },
    can: () => true,
  }),
}))
vi.mock('@/api/workbench/project-api', () => ({
  projectApi: {
    directory: mocks.directory,
    save: mocks.save,
    read: mocks.read,
  },
}))
vi.mock('@/api/workbench/conversation-api', () => ({
  conversationApi: { inventory: mocks.inventory },
}))
let wrapper: VueWrapper | undefined
const existing: WorkspaceProject = {
  id: 'existing',
  connectorId: 'desktop',
  name: '原项目',
  workspacePath: 'C:\\Team',
  pinned: false,
  activeSessionCount: 0,
  manuallyCreated: true,
}
function setup() {
  let vm!: ReturnType<typeof useProjectManager>
  wrapper = mount(
    defineComponent({
      setup() {
        vm = useProjectManager(
          ref<WorkspaceConnector[]>([
            {
              id: 'desktop',
              name: '设备',
              status: 'online',
              executorKind: 'desktop',
              deviceOs: 'windows',
            },
          ]),
          ref([existing]),
          async () => {},
        )
        return () => h('div')
      },
    }),
  )
  vm.edit('new')
  vm.updateDraft({ workspacePath: 'C:/Team', name: '另一个名称' })
  return vm
}
beforeEach(() => {
  mocks.identity = reactive({ generation: 0 })
  mocks.directory.mockReset()
  mocks.save.mockReset().mockResolvedValue({ project: existing })
  mocks.confirm.mockReset()
  mocks.inventory.mockReset()
  mocks.read.mockReset().mockResolvedValue({})
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

describe('项目确认与取消代际边界', () => {
  it('全部已读包含首100条之外和归档清单，按旧单批1000上限提交', async () => {
    const vm = setup()
    const sessions = Array.from({ length: 1001 }, (_, index) => ({
      id: `session-${index}`,
      unread: true,
      archived: index >= 100,
    }))
    mocks.inventory.mockResolvedValue({ sessions })
    await vm.markAllRead()
    expect(mocks.read.mock.calls.map((call) => call[0].length)).toEqual([
      1000, 1,
    ])
    expect(mocks.read.mock.calls.flatMap((call) => call[0])).toEqual(
      sessions.map((item) => item.id),
    )
  })
  it('读取全量清单期间换账号，不提交旧账号的已读数组', async () => {
    const vm = setup()
    let resolve!: (value: {
      sessions: { id: string; unread: boolean }[]
    }) => void
    mocks.inventory.mockImplementation(
      () =>
        new Promise((value) => {
          resolve = value
        }),
    )
    const reading = vm.markAllRead()
    mocks.identity.generation++
    resolve({ sessions: [{ id: 'old-account', unread: true }] })
    await reading
    expect(mocks.read).not.toHaveBeenCalled()
  })
  it('同工作区异名创建取消确认，不写项目且保留草稿', async () => {
    const vm = setup()
    mocks.confirm.mockRejectedValueOnce('cancel')
    await vm.save()
    expect(mocks.confirm).toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
    expect(vm.editing.value).toBe('new')
    expect(vm.draft.name).toBe('另一个名称')
  })
  it('确认期间换账号，即使旧确认随后成功也不发写请求', async () => {
    const vm = setup()
    let confirm!: (value: string) => void
    mocks.confirm.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          confirm = resolve
        }),
    )
    const saving = vm.save()
    mocks.identity.generation += 1
    confirm('confirm')
    await saving
    expect(mocks.save).not.toHaveBeenCalled()
    expect(vm.editing.value).toBeNull()
  })
  it('目录浏览取消后迟到结果不能重开窗口或覆盖下一次输入', async () => {
    const vm = setup()
    let resolve!: (value: { path: string; directories: never[] }) => void
    mocks.directory.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const browsing = vm.browse('C:/Old')
    vm.closeBrowser()
    vm.updatePath('C:/New')
    resolve({ path: 'C:/Old', directories: [] })
    await browsing
    expect(vm.browser.value).toBe(false)
    expect(vm.path.value).toBe('C:/New')
    expect(vm.canChooseDirectory.value).toBe(false)
  })
})
