import { effectScope, nextTick, ref, toRaw } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ElMessageBox } from 'element-plus'
import { useScriptScenes } from '../../fronted/src/composables/studio/use-script-scenes'
import { useScriptConfirmation } from '../../fronted/src/composables/studio/use-script-confirmation'
import { useDirectorChat } from '../../fronted/src/composables/studio/use-director-chat'
import {
  directorInstruction,
  sceneSummary,
} from '../../fronted/src/utils/studio/script-workspace'
import { preparationApi } from '../../fronted/src/api/studio/preparation-api'
import { studioApi } from '../../fronted/src/api/studio/studio-api'
import { conversationApi } from '../../fronted/src/api/workbench/conversation-api'
import { newShot } from '../../fronted/src/utils/studio/storyboard'
import type { StudioProject } from '../../fronted/src/types/studio/studio'

vi.mock('element-plus', () => ({ ElMessageBox: { confirm: vi.fn() } }))
vi.mock('../../fronted/src/api/studio/preparation-api', () => ({
  preparationApi: { confirm: vi.fn() },
}))
vi.mock('../../fronted/src/api/studio/studio-api', () => ({
  studioApi: { chat: vi.fn(), directorRuntime: vi.fn() },
}))
vi.mock('../../fronted/src/api/workbench/conversation-api', () => ({
  conversationApi: { send: vi.fn(), snapshot: vi.fn(), respond: vi.fn() },
}))
function project(): StudioProject {
  return {
    id: 'film',
    title: '雨后',
    revision: 3,
    sessionId: 'director',
    updated: '',
    proposal: null,
    jobs: [],
    history: [],
    assets: [],
    document: {
      script: '两人在站台重逢。',
      adaptationMode: 'original',
      scenes: [
        { id: 'one', title: '站台', synopsis: '重逢' },
        { id: 'two', title: '车厢', synopsis: '出发' },
      ],
      shots: [{ ...newShot(), id: 'shot', sceneId: 'one' }],
      assets: [],
      music: null,
      musicVolume: 1,
    },
  }
}
beforeEach(() => vi.resetAllMocks())

describe('任务式剧本编排', () => {
  it('场次移动保持身份与镜头内容，手动摘录不修改原文', async () => {
    const scope = effectScope(),
      document = ref(project().document)
    const api = scope.run(() => useScriptScenes(document, () => false))!
    const shots = structuredClone(toRaw(document.value.shots))
    api.move(1)
    expect(document.value.scenes?.map((scene) => scene.id)).toEqual([
      'two',
      'one',
    ])
    expect(api.selected.value).toBe('one')
    expect(document.value.shots).toEqual(shots)
    expect(sceneSummary(document.value, 'one').shots).toHaveLength(1)
    api.add('两人在站台重逢。')
    await nextTick()
    expect(api.active.value?.synopsis).toBe('两人在站台重逢。')
    expect(document.value.script).toBe('两人在站台重逢。')
    scope.stop()
  })
  it('不能移除有镜头场次，删除确认期间变为只读也不写入', async () => {
    const scope = effectScope(),
      document = ref(project().document),
      readonly = ref(false)
    const api = scope.run(() =>
      useScriptScenes(document, () => readonly.value),
    )!
    await api.remove()
    expect(ElMessageBox.confirm).not.toHaveBeenCalled()
    api.selected.value = 'two'
    vi.mocked(ElMessageBox.confirm).mockImplementation(async () => {
      readonly.value = true
      return 'confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>
    })
    await api.remove()
    api.add('不应写入')
    expect(document.value.scenes).toHaveLength(2)
    scope.stop()
  })
  it('导演指令明确保护原文，起草和拆解共用审阅边界', () => {
    const base = {
      brief: '重逢后出发',
      script: '你好',
      mode: 'original' as const,
    }
    expect(directorInstruction({ ...base, action: 'decompose' })).toContain(
      '不自行改编',
    )
    expect(
      directorInstruction({ ...base, action: 'draft', script: '' }),
    ).toContain('重逢后出发')
    expect(
      directorInstruction({ ...base, action: 'draft', script: '' }),
    ).toContain('不能直接覆盖')
    expect(directorInstruction({ ...base, action: 'decompose' })).toContain(
      '不生成图片、视频或配音',
    )
  })
  it('审阅失败保留弹窗并复用确认请求号，成功后才进入下一步', async () => {
    const p = ref(project()),
      next = vi.fn(),
      save = vi.fn().mockResolvedValue(undefined)
    const api = useScriptConfirmation({
      project: () => p.value,
      readonly: () => false,
      save,
      confirmed: next,
    })
    vi.mocked(preparationApi.confirm)
      .mockRejectedValueOnce(new Error('暂时断网'))
      .mockResolvedValueOnce({})
    api.review()
    await api.confirm()
    expect(api.open.value).toBe(true)
    expect(next).not.toHaveBeenCalled()
    await api.confirm()
    expect(preparationApi.confirm).toHaveBeenCalledTimes(2)
    expect(vi.mocked(preparationApi.confirm).mock.calls[0]![2].requestKey).toBe(
      vi.mocked(preparationApi.confirm).mock.calls[1]![2].requestKey,
    )
    expect(next).toHaveBeenCalledOnce()
  })
  it('保存失败、审阅后内容变化和待审方案都不能冒充已确认', async () => {
    const p = ref(project()),
      next = vi.fn(),
      save = vi.fn().mockRejectedValueOnce(new Error('保存失败'))
    const api = useScriptConfirmation({
      project: () => p.value,
      readonly: () => false,
      save,
      confirmed: next,
    })
    api.review()
    await api.confirm()
    expect(api.error.value).toBe('保存失败')
    p.value.document.script += '新结尾'
    await api.confirm()
    expect(api.changed.value).toBe(true)
    api.review()
    p.value.proposal = { id: 'pending', revision: 3, shots: [] }
    await api.confirm()
    expect(preparationApi.confirm).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })
  it('导演打开不发送，双击只发送一次，发送后同步失败仍保持已提交语义', async () => {
    const scope = effectScope()
    let finishSave!: () => void
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve
        }),
    )
    vi.mocked(studioApi.directorRuntime).mockResolvedValue({
      agent: { status: 'running' },
    } as Awaited<ReturnType<typeof studioApi.directorRuntime>>)
    vi.mocked(conversationApi.send).mockResolvedValue({})
    vi.mocked(conversationApi.snapshot).mockRejectedValue(
      new Error('状态同步失败'),
    )
    const api = scope.run(() =>
      useDirectorChat({
        project: 'film',
        existing: () => 'director',
        active: () => false,
        allowed: () => true,
        save,
      }),
    )!
    expect(conversationApi.send).not.toHaveBeenCalled()
    const first = api.send('整理场次')
    expect(await api.send('整理场次')).toBe(false)
    finishSave()
    expect(await first).toBe(true)
    expect(conversationApi.send).toHaveBeenCalledOnce()
    expect(api.progress.value).toContain('已发送')
    expect(api.error.value).toContain('暂时无法同步进度')
    scope.stop()
  })
})
