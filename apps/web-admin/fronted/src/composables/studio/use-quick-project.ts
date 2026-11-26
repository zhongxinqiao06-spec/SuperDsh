import { computed, onMounted, onScopeDispose, ref, watch } from 'vue'
import { useAuthStore } from '@/store/modules/auth-store'
import { quickApi } from '@/api/studio/quick-api'
import { studioApi } from '@/api/studio/studio-api'
import { useMutation } from '@/composables/use-mutation'
import { ApiError, errorMessage } from '@/utils/errors'
import { createUuid } from '@/utils/uuid'
import { projectBrief } from '@/utils/studio/foundation'
import {
  alignQuickModel,
  copyQuickDraft,
  initialQuickDraft,
  quickDraftIssue,
  quickSignature,
} from '@/utils/studio/quick'
import type {
  QuickCapabilities,
  QuickInputMode,
  QuickProject,
} from '@/types/studio/quick'
import type { GenerationPlan } from '@/types/studio/production'
import type { StudioAsset, StudioProject } from '@/types/studio/studio'
import type { TextEditTarget } from '@/types/studio/text-edit'

/** 快速创作的草稿、预检和候选用例。后台刷新只更新任务，不覆盖未保存输入。 */
export function useQuickProject(initialId: string | null) {
  const auth = useAuthStore()
  const controller = new AbortController()
  const id = ref(initialId ?? '')
  const state = ref<QuickProject>()
  const capabilities = ref<QuickCapabilities>({
    models: [],
    defaultConfigurationId: null,
  })
  const draft = ref(initialQuickDraft(capabilities.value))
  const title = ref('未命名快速视频')
  const assets = ref<StudioAsset[]>([])
  const selectedId = ref('')
  const baseline = ref('')
  const loading = ref(true),
    loadError = ref(''),
    pollError = ref(''),
    stale = ref(false),
    notice = ref('')
  const mutation = useMutation()
  const plan = ref<GenerationPlan>(),
    planOpen = ref(false)
  const regenerate = ref(false),
    allowDuplicate = ref(false),
    duplicateReason = ref('')
  const aiOpen = ref(false),
    aiProject = ref<StudioProject>(),
    aiTarget = ref<TextEditTarget>()
  const aiBusy = ref(false),
    aiDirty = ref(false)
  const collected = ref<string[]>([])
  const canEdit = computed(
    () =>
      auth.can('studio.projects.write') &&
      state.value?.lifecycle !== 'archived' &&
      state.value?.creationMode !== 'storyboard',
  )
  const busy = computed(() => mutation.busy.value || aiBusy.value)
  const dirty = computed(
    () =>
      baseline.value !== '' &&
      baseline.value !== quickSignature(title.value, draft.value),
  )
  const models = computed(() =>
    capabilities.value.models.filter((model) =>
      model.inputModes.includes(draft.value.inputMode),
    ),
  )
  const model = computed(() =>
    models.value.find((item) => item.id === draft.value.configurationId),
  )
  const issue = computed(() =>
    quickDraftIssue(draft.value, model.value, models.value),
  )
  const jobs = computed(() => state.value?.jobs ?? [])
  const selected = computed(() =>
    jobs.value.find((item) => item.id === selectedId.value),
  )
  const active = computed(() =>
    jobs.value.some((job) =>
      ['queued', 'submitting', 'polling', 'downloading'].includes(job.state),
    ),
  )
  const references = computed(() =>
    draft.value.references.flatMap(
      (key) => assets.value.find((asset) => asset.id === key) ?? [],
    ),
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  let createAttempt:
    { requestKey: string; body: ReturnType<typeof projectBrief> } | undefined
  const attempts = new Map<string, string>()
  function key(operation: string, body: unknown) {
    const identity = operation + ':' + JSON.stringify(body)
    if (!attempts.has(identity)) attempts.set(identity, createUuid())
    return attempts.get(identity)!
  }
  function rememberAssets(items: StudioAsset[]) {
    assets.value = [
      ...new Map(
        [...assets.value, ...items].map((asset) => [asset.id, asset]),
      ).values(),
    ]
  }
  function accept(result: QuickProject, replaceDraft: boolean) {
    if (controller.signal.aborted) return
    capabilities.value = result.capabilities
    rememberAssets(result.assets)
    if (replaceDraft || !dirty.value) {
      state.value = result
      draft.value = copyQuickDraft(result.draft)
      title.value = result.title
      baseline.value = quickSignature(title.value, draft.value)
      stale.value = false
    } else if (state.value) {
      stale.value ||= result.revision !== state.value.revision
      state.value = {
        ...state.value,
        jobs: result.jobs,
        lifecycle: result.lifecycle,
        creationMode: result.creationMode,
      }
    }
    if (!jobs.value.some((job) => job.id === selectedId.value))
      selectedId.value = jobs.value[0]?.id ?? ''
  }
  async function refresh(replaceDraft = false) {
    if (!id.value) return
    accept(await quickApi.open(id.value, controller.signal), replaceDraft)
    pollError.value = ''
  }
  async function load() {
    loading.value = true
    loadError.value = ''
    try {
      if (id.value) await refresh(true)
      else {
        capabilities.value = await quickApi.capabilities(controller.signal)
        controller.signal.throwIfAborted()
        draft.value = initialQuickDraft(capabilities.value)
        baseline.value = quickSignature(title.value, draft.value)
      }
    } catch (cause) {
      if (!controller.signal.aborted) loadError.value = errorMessage(cause)
    } finally {
      if (!controller.signal.aborted) loading.value = false
    }
  }
  async function poll() {
    if (controller.signal.aborted) return
    try {
      if (id.value && !busy.value && active.value) await refresh()
    } catch (cause) {
      if (!controller.signal.aborted)
        pollError.value =
          '任务状态暂时无法更新，正在重连；当前输入已保留。' +
          errorMessage(cause)
    } finally {
      if (!controller.signal.aborted)
        timer = setTimeout(() => void poll(), 4500)
    }
  }
  function setMode(value: QuickInputMode) {
    if (busy.value || !canEdit.value) return
    draft.value.inputMode = value
    const match =
      capabilities.value.models.find(
        (item) =>
          item.id === draft.value.configurationId &&
          item.inputModes.includes(value),
      ) ??
      capabilities.value.models.find((item) => item.inputModes.includes(value))
    draft.value = alignQuickModel(draft.value, match)
  }
  function setModel(value: string) {
    draft.value = alignQuickModel(
      draft.value,
      models.value.find((item) => item.id === value),
    )
  }
  async function persist() {
    if (!canEdit.value) throw new Error('当前作品不可编辑。')
    if (!title.value.trim()) throw new Error('请填写作品名称。')
    if (stale.value) throw new Error('其他页面已更新草稿，请先核对最新版本。')
    if (!id.value) {
      // 创建结果未知时重试原意图；取得作品身份后再保存最新输入，不遗留重复空作品。
      createAttempt ??= {
        requestKey: createUuid(),
        body: { ...projectBrief(), title: title.value.trim() },
      }
      const created = await quickApi.create(
        { ...createAttempt.body, requestKey: createAttempt.requestKey },
        controller.signal,
      )
      controller.signal.throwIfAborted()
      id.value = created.id
      state.value = {
        id: created.id,
        title: created.title,
        revision: created.revision,
        creationMode: 'quick',
        lifecycle: 'active',
        draft: copyQuickDraft(draft.value),
        jobs: [],
        assets: [],
        capabilities: capabilities.value,
      }
    } else if (!dirty.value) return
    const body = {
      revision: state.value!.revision,
      title: title.value.trim(),
      draft: copyQuickDraft(draft.value),
    }
    try {
      const result = await quickApi.save(
        id.value,
        { ...body, requestKey: key('save', body) },
        controller.signal,
      )
      controller.signal.throwIfAborted()
      state.value = { ...state.value!, ...result }
      title.value = result.title
      draft.value = copyQuickDraft(result.draft)
      baseline.value = quickSignature(title.value, draft.value)
      notice.value = '草稿已保存'
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) stale.value = true
      throw cause
    }
  }
  const save = () => mutation.run(persist)
  async function prepare() {
    if (!canEdit.value || !auth.can('models.use')) return
    return mutation.run(async () => {
      if (issue.value) throw new Error(issue.value)
      await persist()
      const body = {
        revision: state.value!.revision,
        regenerate: regenerate.value,
        allowDuplicate: allowDuplicate.value,
        reason: duplicateReason.value,
      }
      plan.value = await quickApi.prepare(
        id.value,
        { ...body, requestKey: key('prepare', body) },
        controller.signal,
      )
      controller.signal.throwIfAborted()
      attempts.delete('prepare:' + JSON.stringify(body))
      planOpen.value = true
    })
  }
  async function confirm() {
    if (!plan.value || !canEdit.value) return false
    return mutation.run(async () => {
      const result = await quickApi.confirm(
        id.value,
        plan.value!,
        controller.signal,
      )
      controller.signal.throwIfAborted()
      await refresh()
      selectedId.value = result.jobs[0]?.id ?? selectedId.value
      planOpen.value = false
      allowDuplicate.value = false
      regenerate.value = false
      duplicateReason.value = ''
      notice.value = '已提交一条视频，离开页面后仍会继续处理。'
    })
  }
  async function collect() {
    const job = selected.value
    if (!job || job.state !== 'ready' || !auth.can('studio.assets.write'))
      return
    return mutation.run(async () => {
      const body = {
        revision: state.value!.revision,
        jobId: job.id,
        name: title.value,
      }
      await quickApi.collect(
        id.value,
        { ...body, requestKey: key('collect', body) },
        controller.signal,
      )
      controller.signal.throwIfAborted()
      collected.value.push(job.id)
      notice.value = '已收藏到我的媒体素材。'
    })
  }
  async function promote() {
    const job = selected.value
    if (!job || job.state !== 'ready' || !canEdit.value) return false
    return mutation.run(async () => {
      await persist()
      const body = { revision: state.value!.revision, jobId: job.id }
      await quickApi.promote(
        id.value,
        { ...body, requestKey: key('promote', body) },
        controller.signal,
      )
      controller.signal.throwIfAborted()
      baseline.value = quickSignature(title.value, draft.value)
    })
  }
  async function download() {
    if (!selected.value || selected.value.state !== 'ready') return
    await mutation.run(async () => {
      const url = await studioApi.media(
        id.value,
        selected.value!.id,
        true,
        controller.signal,
      )
      controller.signal.throwIfAborted()
      const link = document.createElement('a')
      link.href = url
      link.download = ''
      link.click()
    })
  }
  function reuse() {
    if (!canEdit.value || !selected.value?.quickDraft) return
    draft.value = copyQuickDraft(selected.value.quickDraft)
    notice.value = '已带入本次参数，可修改后再生成。'
  }
  async function saveForAi() {
    await persist()
    aiProject.value = await studioApi.open(id.value, controller.signal)
  }
  async function reloadForAi() {
    await refresh(true)
    aiProject.value = await studioApi.open(id.value, controller.signal)
  }
  async function openAi() {
    if (!draft.value.prompt.trim() || !canEdit.value) return
    await mutation.run(async () => {
      await saveForAi()
      const script = aiProject.value!.document.script
      aiTarget.value = {
        scope: 'selection',
        label: '本条视频提示词',
        start: 0,
        end: Array.from(script).length,
        text: script,
        script,
      }
      aiOpen.value = true
    })
  }
  onMounted(
    () =>
      void load().then(() => {
        if (!controller.signal.aborted)
          timer = setTimeout(() => void poll(), 4500)
      }),
  )
  watch(
    () => auth.generation,
    () => {
      controller.abort()
      state.value = undefined
      assets.value = []
      draft.value = initialQuickDraft({
        models: [],
        defaultConfigurationId: null,
      })
      baseline.value = ''
      aiOpen.value = false
    },
  )
  onScopeDispose(() => {
    controller.abort()
    clearTimeout(timer)
  })
  return {
    id,
    state,
    title,
    draft,
    assets,
    references,
    capabilities,
    models,
    model,
    issue,
    jobs,
    selectedId,
    selected,
    active,
    loading,
    loadError,
    pollError,
    stale,
    notice,
    mutation,
    busy,
    dirty,
    canEdit,
    plan,
    planOpen,
    regenerate,
    allowDuplicate,
    duplicateReason,
    collected,
    aiOpen,
    aiProject,
    aiTarget,
    aiBusy,
    aiDirty,
    load,
    refresh,
    rememberAssets,
    setMode,
    setModel,
    save,
    prepare,
    confirm,
    collect,
    promote,
    download,
    reuse,
    openAi,
    saveForAi,
    reloadForAi,
  }
}
