import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, reactive } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { useQuickProject } from '../../fronted/src/composables/studio/use-quick-project'
import { quickApi } from '../../fronted/src/api/studio/quick-api'
import {
  alignQuickModel,
  copyQuickDraft,
  initialQuickDraft,
  quickDraftIssue,
} from '../../fronted/src/utils/studio/quick'
import { workLocation } from '../../fronted/src/utils/studio/works'
import QuickResultPanel from '../../fronted/src/views/studio/components/quick/QuickResultPanel.vue'
import { ApiError } from '../../fronted/src/utils/errors'
import type {
  QuickCapabilities,
  QuickProject,
} from '../../fronted/src/types/studio/quick'
import type { GenerationPlan } from '../../fronted/src/types/studio/production'
import type { WorkSummary } from '../../fronted/src/types/studio/works'

const identity = vi.hoisted(() => ({ generation: 1, canEdit: true }))
vi.mock('@/store/modules/auth-store', () => ({
  useAuthStore: () => ({
    get generation() {
      return identity.generation
    },
    can: (permission: string) =>
      permission !== 'studio.projects.write' || identity.canEdit,
  }),
}))
vi.mock('@/store/session-controller', () => ({
  sessionController: {
    get generation() {
      return identity.generation
    },
  },
}))
vi.mock('@/api/studio/quick-api', () => ({
  quickApi: {
    capabilities: vi.fn(),
    open: vi.fn(),
    create: vi.fn(),
    save: vi.fn(),
    prepare: vi.fn(),
    confirm: vi.fn(),
    collect: vi.fn(),
    promote: vi.fn(),
  },
}))
vi.mock('@/api/studio/studio-api', () => ({
  studioApi: { open: vi.fn(), media: vi.fn() },
}))
const capabilities: QuickCapabilities = {
  defaultConfigurationId: 'reference-model',
  models: [
    {
      id: 'reference-model',
      name: '受控参考模型',
      inputModes: ['reference', 'image'],
      durations: [5, 10],
      aspects: ['9:16'],
      resolutions: ['720P'],
      maxReferences: 2,
    },
    {
      id: 'text-model',
      name: '受控文字模型',
      inputModes: ['text'],
      durations: [6],
      aspects: ['16:9'],
      resolutions: ['720P'],
      maxReferences: 0,
    },
  ],
}
const plan: GenerationPlan = {
  id: 'plan',
  revision: 2,
  planHash: 'hash',
  state: 'prepared',
  items: [
    {
      target: 'quick_test',
      kind: 'video',
      label: '一条快速视频',
      selected: true,
      status: 'missing',
      model: '受控参考模型',
      seconds: 5,
    },
  ],
  issues: [],
}
let remote: QuickProject
let wrappers: VueWrapper[]
function render(id: string | null) {
  let vm!: ReturnType<typeof useQuickProject>
  const wrapper = mount(
    defineComponent({
      setup() {
        vm = useQuickProject(id)
        return () => h('div')
      },
    }),
  )
  wrappers.push(wrapper)
  return vm
}
beforeEach(() => {
  vi.resetAllMocks()
  identity.generation = 1
  identity.canEdit = true
  wrappers = []
  remote = {
    id: 'quick-test',
    title: '合成作品',
    revision: 1,
    creationMode: 'quick',
    lifecycle: 'active',
    draft: {
      ...initialQuickDraft(capabilities),
      prompt: '小狗跳上月球',
      references: ['image-one'],
    },
    jobs: [],
    assets: [],
    capabilities,
  }
  vi.mocked(quickApi.capabilities).mockResolvedValue(capabilities)
  vi.mocked(quickApi.open).mockImplementation(async () =>
    structuredClone(remote),
  )
  vi.mocked(quickApi.create).mockResolvedValue({
    id: remote.id,
    title: remote.title,
    revision: 1,
    sessionId: null,
    updated: '2026-11-18T00:00:00Z',
  })
  vi.mocked(quickApi.save).mockImplementation(async (_id, body) => {
    remote = {
      ...remote,
      title: body.title,
      draft: copyQuickDraft(body.draft),
      revision: body.revision + 1,
    }
    return structuredClone(remote)
  })
  vi.mocked(quickApi.prepare).mockResolvedValue(plan)
  vi.mocked(quickApi.confirm).mockResolvedValue({ jobs: [] })
})
afterEach(() => wrappers.forEach((wrapper) => wrapper.unmount()))

describe('快速视频输入能力', () => {
  it('默认值来自所选模型，切换模型保留正文和参考并校正不支持的参数', () => {
    const draft = initialQuickDraft(capabilities)
    expect(draft).toMatchObject({
      configurationId: 'reference-model',
      inputMode: 'reference',
      durationSeconds: 5,
      aspect: '9:16',
    })
    const next = alignQuickModel(
      {
        ...draft,
        prompt: '保留我的构想',
        references: ['original'],
        inputMode: 'text',
      },
      capabilities.models[1],
    )
    expect(next).toMatchObject({
      prompt: '保留我的构想',
      references: ['original'],
      durationSeconds: 6,
      aspect: '16:9',
    })
    expect(quickDraftIssue(next, capabilities.models[1])).toContain(
      '请移除参考关联',
    )
    expect(copyQuickDraft(reactive(draft))).toEqual(draft)
  })
  it('图生模式准确要求一张图，普通参考模式按实际数量限制', () => {
    const draft = {
      ...initialQuickDraft(capabilities),
      prompt: '飞行',
      references: ['a', 'b', 'c'],
    }
    expect(quickDraftIssue(draft, capabilities.models[0])).toContain(
      '最多支持 2',
    )
    expect(
      quickDraftIssue(
        { ...draft, inputMode: 'image', references: ['a', 'b'] },
        capabilities.models[0],
      ),
    ).toContain('只保留一张')
    expect(
      quickDraftIssue(
        { ...draft, inputMode: 'image', references: ['a'] },
        capabilities.models[0],
      ),
    ).toBe('')
  })
})

describe('快速作品保存与任务恢复', () => {
  it('打开新建页只加载能力，不创建作品或任务；首次保存才创建一次', async () => {
    const vm = render(null)
    await flushPromises()
    expect(quickApi.create).not.toHaveBeenCalled()
    expect(quickApi.prepare).not.toHaveBeenCalled()
    vm.title.value = '新构想'
    vm.draft.value.prompt = '月球旅行'
    expect(await vm.save()).toBe(true)
    expect(await vm.save()).toBe(true)
    expect(quickApi.create).toHaveBeenCalledTimes(1)
    expect(quickApi.save).toHaveBeenCalledTimes(1)
    expect(vm.dirty.value).toBe(false)
  })
  it('创建结果未知时复用原操作身份，再保存用户最新标题', async () => {
    vi.mocked(quickApi.create).mockRejectedValueOnce(
      new ApiError('网络中断', 0),
    )
    const vm = render(null)
    await flushPromises()
    vm.title.value = '第一次标题'
    vm.draft.value.prompt = '出发'
    expect(await vm.save()).toBe(false)
    vm.title.value = '后来改过的标题'
    expect(await vm.save()).toBe(true)
    const calls = vi.mocked(quickApi.create).mock.calls
    expect(calls[0]?.[0]).toEqual(calls[1]?.[0])
    expect(quickApi.save).toHaveBeenLastCalledWith(
      remote.id,
      expect.objectContaining({ title: '后来改过的标题' }),
      expect.any(AbortSignal),
    )
  })
  it('保存失败保留输入，再次保存沿用同一个幂等键', async () => {
    const vm = render(remote.id)
    await flushPromises()
    vm.draft.value.prompt = '手工调整后的动作'
    vi.mocked(quickApi.save).mockRejectedValueOnce(new ApiError('网络中断', 0))
    expect(await vm.save()).toBe(false)
    expect(vm.draft.value.prompt).toBe('手工调整后的动作')
    expect(await vm.save()).toBe(true)
    const calls = vi.mocked(quickApi.save).mock.calls
    expect(calls[0]?.[1].requestKey).toBe(calls[1]?.[1].requestKey)
  })
  it('任务刷新不会吞掉本地草稿，并发修订变化要求先核对', async () => {
    const vm = render(remote.id)
    await flushPromises()
    vm.draft.value.prompt = '尚未保存的本地稿'
    remote.revision = 3
    remote.draft.prompt = '另一页保存的稿'
    remote.jobs = [
      {
        id: 'job-a',
        subject: 'quick_test',
        kind: 'video',
        state: 'polling',
        revision: 1,
        duration: null,
        error: null,
      },
    ]
    await vm.refresh()
    expect(vm.draft.value.prompt).toBe('尚未保存的本地稿')
    expect(vm.jobs.value[0]?.state).toBe('polling')
    expect(vm.stale.value).toBe(true)
    await vm.prepare()
    expect(quickApi.prepare).not.toHaveBeenCalled()
    await vm.refresh(true)
    expect(vm.draft.value.prompt).toBe('另一页保存的稿')
    expect(vm.stale.value).toBe(false)
  })
  it('预检不提交，失败确认可用同一冻结计划重试', async () => {
    const vm = render(remote.id)
    await flushPromises()
    await vm.prepare()
    expect(quickApi.confirm).not.toHaveBeenCalled()
    expect(vm.planOpen.value).toBe(true)
    vi.mocked(quickApi.confirm).mockRejectedValueOnce(
      new ApiError('受理结果未知', 0),
    )
    expect(await vm.confirm()).toBe(false)
    expect(vm.planOpen.value).toBe(true)
    expect(await vm.confirm()).toBe(true)
    const calls = vi.mocked(quickApi.confirm).mock.calls
    expect(calls[0]?.[1].id).toBe(calls[1]?.[1].id)
    expect(quickApi.prepare).toHaveBeenCalledTimes(1)
  })
  it('选择或复用旧候选不生成任务，收藏使用明确选中的候选身份', async () => {
    remote.jobs = ['old', 'new'].map((id) => ({
      id,
      subject: 'quick_test',
      kind: 'video',
      state: 'ready',
      revision: 1,
      duration: 5000,
      error: null,
      quickDraft: { ...remote.draft, prompt: id },
    }))
    const vm = render(remote.id)
    await flushPromises()
    vm.selectedId.value = 'old'
    vm.reuse()
    expect(vm.draft.value.prompt).toBe('old')
    expect(quickApi.prepare).not.toHaveBeenCalled()
    await vm.collect()
    expect(quickApi.collect).toHaveBeenCalledWith(
      remote.id,
      expect.objectContaining({ jobId: 'old' }),
      expect.any(AbortSignal),
    )
  })
  it('只读用户可加载候选，但不能保存或提交', async () => {
    identity.canEdit = false
    const vm = render(remote.id)
    await flushPromises()
    expect(vm.state.value?.id).toBe(remote.id)
    expect(vm.canEdit.value).toBe(false)
    expect(await vm.save()).toBe(false)
    await vm.prepare()
    expect(quickApi.save).not.toHaveBeenCalled()
    expect(quickApi.prepare).not.toHaveBeenCalled()
  })
  it('候选显示后端稳定编号，状态更新与顺序变化不改名', async () => {
    const jobs = [3, 1].map((number) => ({
      id: 'job-' + number,
      candidateNumber: number,
      kind: 'video' as const,
      subject: 'quick_test',
      state: 'queued',
      revision: 1,
      duration: null,
      error: null,
    }))
    const wrapper = mount(QuickResultPanel, {
      props: {
        modelValue: 'job-3',
        project: 'project',
        jobs,
        busy: false,
        canEdit: true,
        canCollect: true,
        collected: false,
      },
      global: {
        stubs: {
          ScrollPanel: {
            template:
              '<section><slot name="header"/><slot/><slot name="footer"/></section>',
          },
          StudioMedia: true,
          StudioRecovery: true,
          ManagementPagination: true,
          ExpandableText: true,
          ElButton: { template: '<button><slot/></button>' },
        },
      },
    })
    wrappers.push(wrapper)
    expect(
      wrapper
        .findAll('.quick-candidate strong')
        .map((item) => item.text().replace(/\s/gu, '')),
    ).toEqual(['候选3', '候选1'])
    await wrapper.setProps({
      jobs: [{ ...jobs[1]!, state: 'failed' }, jobs[0]!],
    })
    expect(
      wrapper
        .findAll('.quick-candidate strong')
        .map((item) => item.text().replace(/\s/gu, '')),
    ).toEqual(['候选1', '候选3'])
    await wrapper.findAll('.quick-candidate')[0]!.trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['job-1'])
  })
  it('系列继续入口携带稳定集身份，旧分镜作品路径保持兼容', () => {
    const work = {
      kind: 'series',
      id: 'series-a',
      currentEpisodeId: 'episode-a',
    } as WorkSummary
    expect(workLocation(work)).toBe(
      '/entertainment/series/series-a?episode=episode-a&resume=1',
    )
    expect(workLocation({ ...work, kind: 'storyboard' })).toBe(
      '/entertainment/series-a',
    )
  })
})
