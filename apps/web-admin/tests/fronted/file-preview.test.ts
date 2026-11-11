import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, reactive } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import {
  previewCaret,
  previewLocation,
  previewSourceUrl,
} from '@/utils/file-preview/preview-location'
import { useFilePreview } from '@/composables/file-preview/use-file-preview'

const mocks = vi.hoisted(() => ({
  exchange: vi.fn(),
  load: vi.fn(),
  text: vi.fn(),
  save: vi.fn(),
  list: vi.fn(),
  hydrate: vi.fn(),
  auth: { generation: 0, authenticated: true, can: () => true },
  route: { fullPath: '/preview', query: {} as Record<string, string> },
}))
vi.mock('@/api/file-preview/preview-api', () => ({
  previewApi: {
    exchange: mocks.exchange,
    load: mocks.load,
    text: mocks.text,
    save: mocks.save,
    list: mocks.list,
  },
}))
vi.mock('@/store/modules/auth-store', () => ({
  useAuthStore: () => Object.assign(mocks.auth, { hydrate: mocks.hydrate }),
}))
vi.mock('vue-router', () => ({
  useRoute: () => mocks.route,
  useRouter: () => ({ push: vi.fn() }),
  onBeforeRouteLeave: vi.fn(),
  onBeforeRouteUpdate: vi.fn(),
}))
let wrapper: VueWrapper | undefined
const textBlob = (text: string) =>
  Object.assign(new Blob([text], { type: 'text/plain' }), {
    text: async () => text,
  })
beforeEach(() => {
  vi.clearAllMocks()
  mocks.route = reactive({
    fullPath: '/preview',
    query: { connectorId: 'owned', root: '/workspace', path: 'file.txt' },
  })
  mocks.auth = reactive({ generation: 0, authenticated: true, can: () => true })
  mocks.load.mockResolvedValue(textBlob('原始内容'))
  mocks.text.mockResolvedValue({ content: '原始内容', sha256: 'digest' })
  mocks.list.mockRejectedValue(new Error('不是目录'))
  mocks.hydrate.mockResolvedValue(undefined)
  URL.createObjectURL = vi.fn(() => 'blob:synthetic-preview')
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

function setup(): ReturnType<typeof useFilePreview> {
  let vm!: ReturnType<typeof useFilePreview>
  wrapper = mount(
    defineComponent({
      setup() {
        vm = useFilePreview()
        return () => h('div')
      },
    }),
  )
  return vm
}

describe('独立预览权限与生命周期', () => {
  it('换号立即清理旧正文与预览地址', async () => {
    const vm = setup()
    await flushPromises()
    expect(vm.content.value).toBe('原始内容')
    mocks.auth.generation += 1
    await flushPromises()
    expect(vm.content.value).toBe('')
    expect(vm.objectUrl.value).toBe('')
    expect(vm.error.value).toContain('账号状态已变化')
    expect(URL.revokeObjectURL).toHaveBeenCalled()
  })
  it('路由只接受字符串并限制行列，来源URL禁止外域和脚本协议', () => {
    expect(
      previewLocation({
        connectorId: ['wrong'],
        line: '-2',
        column: '999999999',
      }),
    ).toMatchObject({ connectorId: '', line: 1, column: 1_000_000 })
    expect(previewCaret('甲\n乙丙', 2, 2)).toBe(3)
    expect(() =>
      previewSourceUrl(
        'https://foreign.invalid/api/files/file/content',
        'https://platform.invalid',
      ),
    ).toThrow('当前平台')
    expect(() =>
      previewSourceUrl('javascript:alert(1)', 'https://platform.invalid'),
    ).toThrow('当前平台')
    expect(
      previewSourceUrl('/api/files/file/content', 'https://platform.invalid'),
    ).toBe('https://platform.invalid/api/files/file/content')
  })
  it('一次性票据只交换一次，刷新复用受限会话且不可进入编辑', async () => {
    mocks.route.query = { previewToken: 'single-use' }
    mocks.exchange.mockResolvedValue({
      previewAccessToken: 'restricted',
      connectorId: 'owned',
      root: '/workspace',
      path: 'file.txt',
    })
    const vm = setup()
    await flushPromises()
    expect(vm.content.value).toBe('原始内容')
    expect(vm.writable.value).toBe(false)
    await vm.load()
    expect(mocks.exchange).toHaveBeenCalledTimes(1)
    expect(mocks.text).not.toHaveBeenCalled()
    expect(mocks.hydrate).not.toHaveBeenCalled()
    wrapper?.unmount()
    wrapper = undefined
    expect(URL.revokeObjectURL).toHaveBeenCalled()
  })
  it('保存摘要冲突保留草稿，不重试有副作用的写入', async () => {
    const vm = setup()
    await flushPromises()
    expect(vm.writable.value).toBe(true)
    vm.editing.value = true
    vm.content.value = '待保存草稿'
    mocks.save.mockRejectedValue(new Error('文件已被修改'))
    await vm.save()
    expect(vm.content.value).toBe('待保存草稿')
    expect(vm.dirty.value).toBe(true)
    expect(vm.saveError.value).toBe('文件已被修改')
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith(
      'owned',
      'file.txt',
      '待保存草稿',
      'digest',
      '/workspace',
    )
  })
  it('路径切换后迟到文件不能覆盖新路径或创建泄漏的URL', async () => {
    let complete!: (value: Blob) => void
    mocks.load.mockImplementationOnce(
      () =>
        new Promise<Blob>((resolve) => {
          complete = resolve
        }),
    )
    const vm = setup()
    await flushPromises()
    mocks.route.query.path = 'second.txt'
    mocks.route.fullPath = '/preview?path=second.txt'
    await flushPromises()
    complete(textBlob('不应显示的迟到内容'))
    await flushPromises()
    expect(vm.content.value).toBe('原始内容')
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
  })
  it('文件读取失败后允许目录浏览，目录失败时保留原错误', async () => {
    mocks.load.mockRejectedValue(new Error('文件不可读'))
    mocks.list.mockResolvedValueOnce({
      path: '/workspace',
      entries: [
        {
          name: 'child.txt',
          path: '/workspace/child.txt',
          isDirectory: false,
          size: 7,
        },
      ],
    })
    const vm = setup()
    await flushPromises()
    expect(vm.entries.value?.[0]?.name).toBe('child.txt')
    expect(vm.error.value).toBe('')
    await vm.load()
    expect(vm.error.value).toBe('文件不可读')
  })
})
