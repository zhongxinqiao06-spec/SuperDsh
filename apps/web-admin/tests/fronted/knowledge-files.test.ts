import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { useKnowledgeFiles } from '@/composables/knowledge/use-knowledge-files'
import type { AgentAsset } from '@/types/agents/agents'
import type { KnowledgeBase } from '@/types/knowledge/knowledge'

const mocks = vi.hoisted(() => ({
  generation: 0,
  save: vi.fn(),
  index: vi.fn(),
  upload: vi.fn(),
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
  }),
}))
vi.mock('@/api/knowledge/knowledge-api', () => ({
  knowledgeApi: { save: mocks.save, index: mocks.index },
}))
vi.mock('@/api/agents/agents-api', () => ({
  agentsApi: { upload: mocks.upload },
}))
vi.mock('@/utils/agents/agent-drafts', () => ({
  assetBase64: async () => 'c3ludGhldGlj',
}))
const asset: AgentAsset = {
  id: 'a',
  name: '合成资料.txt',
  kind: 'knowledge',
  size: 9,
  mediaType: 'text/plain',
  sha256: 'synthetic',
  preview: 'synthetic',
  createdAt: '',
}
const base: KnowledgeBase = {
  id: 'kb',
  name: '合成知识库',
  description: '合成用途',
  enabled: true,
  version: 7,
  assetIds: ['a'],
  createdAt: '',
  updatedAt: '',
}
let wrapper: VueWrapper | undefined
function setup() {
  const reload = vi.fn(async () => {})
  let vm!: ReturnType<typeof useKnowledgeFiles>
  wrapper = mount(
    defineComponent({
      setup() {
        vm = useKnowledgeFiles(reload)
        return () => h('div')
      },
    }),
  )
  vm.open(base)
  return { vm, reload }
}
beforeEach(() => {
  mocks.generation = 0
  mocks.save.mockReset().mockImplementation(async (draft) => ({
    knowledgeBase: { ...base, ...draft, version: 8 },
  }))
  mocks.index.mockReset().mockResolvedValue({})
  mocks.upload.mockReset().mockResolvedValue({ asset: { ...asset, id: 'new' } })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

describe('知识库管理文件的关联生命周期', () => {
  it('移出仅按当前版本保存关联，成功后索引与刷新，不删除原文件', async () => {
    const { vm, reload } = setup()
    await vm.remove(asset)
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ version: 7, assetIds: [] }),
      'kb',
    )
    expect(vm.target.value?.version).toBe(8)
    expect(mocks.index).toHaveBeenCalledWith('kb')
    expect(reload).toHaveBeenCalled()
    expect(base.assetIds).toEqual(['a'])
  })
  it('冲突保留关联和错误，不重建索引', async () => {
    const { vm } = setup()
    mocks.save.mockRejectedValueOnce(new Error('版本冲突'))
    await vm.remove(asset)
    expect(vm.target.value?.assetIds).toEqual(['a'])
    expect(vm.mutation.error.value).toContain('版本冲突')
    expect(mocks.index).not.toHaveBeenCalled()
  })
  it('上传后关联失败重试只保存关系，不重复上传', async () => {
    const { vm } = setup()
    vm.assets.file.value = new File(['synthetic'], '合成资料.txt', {
      type: 'text/plain',
    })
    vm.assets.name.value = '合成资料.txt'
    vm.assets.uploading.value = true
    mocks.save.mockRejectedValueOnce(new Error('合成失败'))
    await vm.assets.upload()
    expect(vm.assets.uploading.value).toBe(true)
    await vm.assets.upload()
    expect(mocks.upload).toHaveBeenCalledTimes(1)
    expect(mocks.save).toHaveBeenCalledTimes(2)
    expect(vm.target.value?.assetIds).toEqual(['a', 'new'])
    expect(vm.assets.uploading.value).toBe(false)
  })
  it('换账号后的迟到写结果不刷新、索引或覆盖当前窗口', async () => {
    const { vm, reload } = setup()
    let done!: (value: unknown) => void
    mocks.save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          done = resolve
        }),
    )
    const removing = vm.remove(asset)
    mocks.generation += 1
    done({ knowledgeBase: { ...base, assetIds: [], version: 8 } })
    await removing
    expect(vm.target.value?.assetIds).toEqual(['a'])
    expect(reload).not.toHaveBeenCalled()
    expect(mocks.index).not.toHaveBeenCalled()
  })
})
