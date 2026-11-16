import { effectScope } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDirectorSources } from '../../fronted/src/composables/studio/use-director-sources'
import { useDirectorChat } from '../../fronted/src/composables/studio/use-director-chat'
import { directorContextApi } from '../../fronted/src/api/studio/director-context-api'
import { studioApi } from '../../fronted/src/api/studio/studio-api'
import { conversationApi } from '../../fronted/src/api/workbench/conversation-api'
import { uploadFile } from '../../fronted/src/api/files/upload-api'
import { ApiError } from '../../fronted/src/utils/errors'
import type { UploadedAttachment } from '../../fronted/src/types/workbench/models'

vi.mock('../../fronted/src/api/studio/director-context-api', () => ({
  directorContextApi: { capabilities: vi.fn(), prepare: vi.fn() },
}))
vi.mock('../../fronted/src/api/studio/studio-api', () => ({
  studioApi: {
    library: vi.fn(),
    chat: vi.fn(),
    refreshChat: vi.fn(),
    directorRuntime: vi.fn(),
  },
}))
vi.mock('../../fronted/src/api/files/upload-api', () => ({
  uploadFile: vi.fn(),
}))
vi.mock('../../fronted/src/api/workbench/conversation-api', () => ({
  conversationApi: { send: vi.fn(), snapshot: vi.fn() },
}))
const picture: UploadedAttachment = {
  fileId: 'picture',
  name: '噜噜.png',
  mediaType: 'image/png',
  size: 10,
  sha256: 'test-hash',
}
beforeEach(() => {
  vi.resetAllMocks()
  Object.defineProperty(URL, 'createObjectURL', {
    value: vi.fn(() => 'blob:portrait'),
    configurable: true,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    value: vi.fn(),
    configurable: true,
  })
})
function sourcePanel(revision = () => 3) {
  const scope = effectScope()
  const save = vi.fn().mockResolvedValue(undefined),
    reload = vi.fn().mockResolvedValue(undefined)
  const sources = scope.run(() =>
    useDirectorSources({
      project: 'film',
      active: () => false,
      revision,
      save,
      reload,
      canReadAssets: () => true,
      canUpload: () => true,
    }),
  )!
  sources.capabilities.value = {
    vision: { available: true },
    research: { available: true },
  }
  return { scope, sources, save, reload }
}
describe('导演参考资料与工具恢复', () => {
  it('图片上传失败保留已上传资料，准备前不会创建角色或工程', async () => {
    const { scope, sources } = sourcePanel()
    vi.mocked(uploadFile)
      .mockResolvedValueOnce(picture)
      .mockRejectedValueOnce(new Error('断网'))
    await sources.upload([
      new File(['a'], '噜噜.png', { type: 'image/png' }),
      new File(['b'], '海岛.png', { type: 'image/png' }),
    ])
    expect(sources.uploads.value).toHaveLength(1)
    expect(sources.uploads.value[0]?.name).toBe('噜噜')
    expect(sources.error.value).toContain('已上传的图片已保留')
    expect(directorContextApi.prepare).not.toHaveBeenCalled()
    scope.stop()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:portrait')
  })
  it('资料准备失败同号重试，成功后发送重试不再次调用读图和联网', async () => {
    const { scope, sources, save, reload } = sourcePanel()
    sources.uploads.value = [
      { file: picture, name: '噜噜', preview: 'blob:portrait' },
    ]
    sources.setUploadName('picture', '噜噜出游')
    sources.setAnalyzeImages(false)
    expect(sources.analyzeImages.value).toBe(false)
    sources.setAnalyzeImages(true)
    sources.setResearch(true)
    sources.setResearchQuery('海南海边特色')
    vi.mocked(directorContextApi.prepare)
      .mockRejectedValueOnce(new Error('暂时断网'))
      .mockResolvedValueOnce({
        text: '已识别形象与资料',
        attachments: [],
        revision: 4,
        assetIds: ['lulu'],
      })
    await expect(sources.prepare('噜噜去海南')).rejects.toThrow('暂时断网')
    const first = vi.mocked(directorContextApi.prepare).mock.calls[0]![1]
    const prepared = await sources.prepare('噜噜去海南')
    expect(vi.mocked(directorContextApi.prepare).mock.calls[1]![1]).toEqual(
      first,
    )
    expect(first).toMatchObject({
      revision: 3,
      uploads: [{ fileId: 'picture', name: '噜噜出游' }],
      analyzeImages: true,
      researchQuery: '海南海边特色',
    })
    expect(await sources.prepare('噜噜去海南')).toEqual(prepared)
    expect(directorContextApi.prepare).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenCalledTimes(3)
    expect(reload).toHaveBeenCalledTimes(2)
    scope.stop()
  })
  it('供应商待核对时保留同一请求号，工程冲突只刷新修订而不丢收费收据身份', async () => {
    let revision = 3
    const { scope, sources, reload } = sourcePanel(() => revision)
    sources.selected.value = ['lulu']
    vi.mocked(directorContextApi.prepare)
      .mockRejectedValueOnce(
        new ApiError('受理待核对', 409, 'provider_operation_pending'),
      )
      .mockRejectedValueOnce(
        new ApiError('工程修订变化', 409, 'director_context_conflict'),
      )
      .mockResolvedValueOnce({
        text: '图像说明',
        attachments: [],
        revision: 5,
        assetIds: ['project-lulu'],
      })
    await expect(sources.prepare('海南')).rejects.toThrow('受理待核对')
    expect(reload).not.toHaveBeenCalled()
    const first = vi.mocked(directorContextApi.prepare).mock.calls[0]![1]
    reload.mockImplementation(async () => {
      revision = 4
    })
    await expect(sources.prepare('海南')).rejects.toThrow('工程修订变化')
    await sources.prepare('海南')
    const requests = vi
      .mocked(directorContextApi.prepare)
      .mock.calls.map((call) => call[1])
    expect(requests.map((body) => body.requestKey)).toEqual([
      first.requestKey,
      first.requestKey,
      first.requestKey,
    ])
    expect(requests.map((body) => body.revision)).toEqual([3, 3, 4])
    scope.stop()
  })
  it('未开通联网不能冒充查询成功，选过的个人库版本明确传递', async () => {
    const { scope, sources } = sourcePanel()
    sources.selected.value = ['lulu-version']
    sources.setResearch(true)
    sources.capabilities.value = {
      vision: { available: false },
      research: { available: false },
    }
    await expect(sources.prepare('海南')).rejects.toThrow('联网查询尚不可用')
    expect(directorContextApi.prepare).not.toHaveBeenCalled()
    sources.setResearch(false)
    vi.mocked(directorContextApi.prepare).mockResolvedValue({
      text: '引用形象',
      attachments: [],
      revision: 4,
      assetIds: ['project-lulu'],
    })
    await sources.prepare('海南')
    expect(
      vi.mocked(directorContextApi.prepare).mock.calls[0]![1],
    ).toMatchObject({ assetIds: ['lulu-version'], analyzeImages: false })
    scope.stop()
  })
  it('绑定失效只显示恢复入口，明确更新后沿用会话发送附件', async () => {
    const scope = effectScope()
    const chat = scope.run(() =>
      useDirectorChat({
        project: 'film',
        active: () => false,
        existing: () => null,
        allowed: () => true,
        save: vi.fn().mockResolvedValue(undefined),
      }),
    )!
    vi.mocked(studioApi.chat).mockRejectedValueOnce(
      new ApiError('绑定已过期', 409, 'tool_implementation_changed'),
    )
    expect(await chat.send('噜噜去海南', undefined, [picture])).toBe(false)
    expect(chat.bindingOutdated.value).toBe(true)
    expect(studioApi.refreshChat).not.toHaveBeenCalled()
    vi.mocked(studioApi.refreshChat).mockResolvedValue({
      sessionId: 'director',
      agentId: 'default',
      updatedTools: 5,
    })
    expect(await chat.refreshBinding()).toBe(true)
    vi.mocked(studioApi.directorRuntime).mockResolvedValue({
      agent: { status: 'running' },
    } as Awaited<ReturnType<typeof studioApi.directorRuntime>>)
    vi.mocked(conversationApi.send).mockResolvedValue({})
    vi.mocked(conversationApi.snapshot).mockRejectedValue(
      new Error('暂时同步失败'),
    )
    expect(await chat.send('噜噜去海南', undefined, [picture])).toBe(true)
    expect(
      vi.mocked(conversationApi.send).mock.calls[0]![1].attachments,
    ).toEqual([picture])
    expect(chat.session.value).toBe('director')
    scope.stop()
  })
})
