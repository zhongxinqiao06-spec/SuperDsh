import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { useFiles } from '@/composables/files/use-files'
import type { FileEntry, FileFilter, FileList } from '@/types/files/files'

const mocks = vi.hoisted(() => ({
  generation: 0,
  writable: true,
  list: vi.fn(),
  trash: vi.fn(),
}))
vi.mock('@/store/session-controller', () => ({
  sessionController: {
    get generation() {
      return mocks.generation
    },
  },
}))
vi.mock('@/store/modules/auth-store', () => ({
  useAuthStore: () => ({
    get generation() {
      return mocks.generation
    },
    can: (permission: string) => permission === 'files.write' && mocks.writable,
  }),
}))
vi.mock('@/api/files/files-api', () => ({
  filesApi: { list: mocks.list, trash: mocks.trash },
  downloadFile: vi.fn(),
}))
vi.mock('@/api/files/upload-api', () => ({ uploadFile: vi.fn() }))
vi.mock('@/api/storage/storage-api', () => ({
  storageApi: { settings: vi.fn() },
}))
const file: FileEntry = {
  id: 'file',
  ownerUserId: 'owner',
  name: '合成.txt',
  size: 9,
  sha256: 'synthetic',
  mediaType: 'text/plain',
  category: 'document',
  version: 1,
  previousFileId: null,
  storageId: 'local',
  createdAt: '',
  deletedAt: null,
  references: [],
}
const list: FileList = { items: [file], total: 1, page: 1, pageSize: 10 }
let wrapper: VueWrapper | undefined
function setup() {
  let vm!: ReturnType<typeof useFiles>
  wrapper = mount(
    defineComponent({
      setup() {
        vm = useFiles()
        return () => h('div')
      },
    }),
  )
  return vm
}
beforeEach(() => {
  mocks.generation = 0
  mocks.writable = true
  mocks.list.mockReset().mockResolvedValue(list)
  mocks.trash.mockReset().mockResolvedValue({})
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

describe('文件库旧交互边界', () => {
  it('输入即筛选，后到的旧查询不能覆盖最新结果', async () => {
    const vm = setup()
    await flushPromises()
    let done!: (value: FileList) => void
    mocks.list.mockImplementation((filter: FileFilter) =>
      filter.search === 'first'
        ? new Promise((resolve) => {
            done = resolve
          })
        : Promise.resolve({
            ...list,
            items: [{ ...file, name: filter.search }],
          }),
    )
    vm.filter.page = 3
    vm.query.value = 'first'
    await flushPromises()
    expect(vm.filter.page).toBe(1)
    vm.query.value = 'second'
    await flushPromises()
    done({ ...list, items: [{ ...file, name: 'stale' }] })
    await flushPromises()
    expect(vm.resource.data.value?.items[0]?.name).toBe('second')
  })
  it('回收站切换重新从第一页加载，恢复走同一写入口', async () => {
    const vm = setup()
    await flushPromises()
    vm.filter.page = 4
    vm.toggleTrash()
    await flushPromises()
    expect(mocks.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, deleted: true }),
      expect.any(AbortSignal),
    )
    await vm.trash({ ...file, deletedAt: '2026-11-01T00:00:00Z' })
    expect(mocks.trash).toHaveBeenCalledWith('file', true)
  })
  it('引用保护及权限阻止回收请求，服务端冲突保留文件并显示错误', async () => {
    const vm = setup()
    await flushPromises()
    await vm.trash({
      ...file,
      references: [{ fileId: 'file', kind: 'session', resourceId: 'session' }],
    })
    mocks.writable = false
    await vm.trash(file)
    expect(mocks.trash).not.toHaveBeenCalled()
    mocks.writable = true
    mocks.trash.mockRejectedValueOnce(new Error('文件仍被引用'))
    await vm.trash(file)
    expect(vm.mutation.error.value).toBe('文件仍被引用')
    expect(vm.resource.data.value?.items).toEqual([file])
  })
})
