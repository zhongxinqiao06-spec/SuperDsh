import { ApiError } from '@/utils/errors'
import { computed, onMounted, onScopeDispose, ref, watch } from 'vue'
import { studioApi } from '@/api/studio/studio-api'
import { libraryApi } from '@/api/studio/library-api'
import type { LibraryProjectResult } from '@/types/studio/library'
import { useAuthStore } from '@/store/modules/auth-store'
import type {
  Generation,
  Job,
  StudioAsset,
  StudioCatalog,
  StudioProject,
} from '@/types/studio/studio'
import { newId } from '@/utils/studio/storyboard'

/** 轮询只更新任务和草案，本地未保存的编辑继续保留；版本冲突由用户处理。 */
export function useStudioEditor(id: string) {
  const auth = useAuthStore()
  const project = ref<StudioProject>()
  const catalog = ref<StudioCatalog>()
  const busy = ref(false),
    error = ref(''),
    notice = ref(''),
    stale = ref(false)
  const selectedVideo = ref(''),
    selectedReference = ref(''),
    selectedSpeech = ref('')
  const before = ref('')
  const saving = ref(false)
  const libraryChanging = ref(false)
  const saveFailed = ref(false)
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let saveFlight: Promise<void> | undefined
  let saveAttempt: { key: string; signature: string } | undefined
  const dirty = computed(
    () =>
      !!project.value &&
      before.value !== JSON.stringify(project.value.document),
  )
  const controller = new AbortController()
  let pollError = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  let attempt: { key: string; signature: string } | null = null
  async function run(action: () => Promise<void>) {
    if (busy.value) return false
    busy.value = true
    error.value = ''
    notice.value = ''
    try {
      await action()
      return !controller.signal.aborted
    } catch (e) {
      if (!controller.signal.aborted)
        error.value = e instanceof Error ? e.message : String(e)
      return false
    } finally {
      busy.value = false
    }
  }
  function setProject(value: StudioProject) {
    project.value = value
    before.value = JSON.stringify(value.document)
    stale.value = false
    saveFailed.value = false
  }
  async function reload() {
    setProject(await studioApi.open(id, controller.signal))
  }
  /** 公共引用先保存当前草稿，再以当前修订导入；返回的完整快照成为下一次编辑基线。 */
  const importAttempts = new Map<string, { revision: number; key: string }>()
  async function importAsset(source: StudioAsset): Promise<StudioAsset> {
    if (libraryChanging.value) throw new Error('正在引用素材，请稍候')
    await save()
    if (libraryChanging.value) throw new Error('正在引用素材，请稍候')
    const current = project.value
    if (!current) throw new Error('作品尚未加载完成')
    const existing = current.assets.find(
      (item) =>
        item.id === source.id && current.document.assets.includes(item.id),
    )
    if (existing) return existing
    let attempt = importAttempts.get(source.id)
    if (attempt?.revision !== current.revision) {
      attempt = { revision: current.revision, key: newId() }
      importAttempts.set(source.id, attempt)
    }
    libraryChanging.value = true
    try {
      const result = await libraryApi.import(id, {
        sourceVersionId: source.id,
        expectedRevision: attempt.revision,
        requestKey: attempt.key,
      })
      if (controller.signal.aborted) throw new Error('作品已关闭')
      applyLibraryResult(result)
      importAttempts.delete(source.id)
      const imported = result.assets.find((item) => item.id === result.assetId)
      if (!imported) throw new Error('已引用素材，但未返回对应版本，请刷新作品')
      return imported
    } finally {
      libraryChanging.value = false
    }
  }
  function applyLibraryResult(result: LibraryProjectResult) {
    if (!project.value) return
    if (result.revision < project.value.revision) return
    setProject({
      ...project.value,
      revision: result.revision,
      document: result.document,
      assets: result.assets,
    })
  }
  async function poll() {
    try {
      if (
        !busy.value &&
        (!project.value || (!catalog.value && auth.can('models.use')))
      ) {
        await initialize()
        error.value = ''
      }
      if (project.value && !busy.value && !libraryChanging.value) {
        const current = await studioApi.open(id, controller.signal)
        // 重载/网络短暂中断恢复后只清除轮询错误，保存或用户操作失败继续保留。
        if (pollError && error.value === pollError) error.value = ''
        pollError = ''
        // 较慢的轮询可能在用户保存之后到达，不能用旧修订覆盖刚刚保存的工程。
        if (
          !project.value ||
          busy.value ||
          libraryChanging.value ||
          current.revision < project.value.revision
        )
          return
        if (current.revision !== project.value.revision && !dirty.value)
          setProject(current)
        else {
          project.value.jobs = current.jobs
          project.value.assets = current.assets
          project.value.proposal = current.proposal
          if (!saveFailed.value)
            stale.value = current.revision !== project.value.revision
        }
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        pollError =
          '连接暂时中断，正在重连；当前草稿已保留。' +
          (e instanceof Error ? e.message : String(e))
        if (!saveFailed.value) error.value = pollError
      }
    } finally {
      if (!controller.signal.aborted) timer = setTimeout(poll, 4500)
    }
  }
  async function save(label = '编辑工程'): Promise<void> {
    if (saveFlight) {
      await saveFlight
      if (dirty.value) return save(label)
      return
    }
    const p = project.value
    if (!p || !dirty.value) return
    if (stale.value) throw new Error('工程已更新，请先处理版本冲突')
    const snapshot = JSON.stringify(p.document)
    const signature = JSON.stringify([p.revision, snapshot, label])
    if (saveAttempt?.signature !== signature)
      saveAttempt = { key: newId(), signature }
    saving.value = true
    saveFlight = (async () => {
      try {
        const result = await studioApi.save(
          id,
          p.revision,
          JSON.parse(snapshot),
          label,
          saveAttempt!.key,
        )
        if (controller.signal.aborted) return
        p.revision = result.revision
        // 保存期间继续输入时保留新草稿，下一次保存仍引用同一组稳定对象。
        if (JSON.stringify(p.document) === snapshot && result.document)
          p.document = result.document
        before.value = JSON.stringify(result.document ?? JSON.parse(snapshot))
        if (result.assets) p.assets = result.assets
        p.history.unshift({ revision: result.revision, label })
        saveFailed.value = false
        saveAttempt = undefined
        error.value = ''
        notice.value = '已自动保存'
      } catch (cause) {
        saveFailed.value = true
        if (cause instanceof ApiError && cause.status === 409)
          stale.value = true
        throw cause
      } finally {
        saving.value = false
        saveFlight = undefined
      }
    })()
    return saveFlight
  }
  function scheduleSave() {
    clearTimeout(saveTimer)
    if (
      !dirty.value ||
      stale.value ||
      saveFailed.value ||
      project.value?.lifecycle === 'archived' ||
      !auth.can('studio.projects.write')
    )
      return
    saveTimer = setTimeout(() => {
      if (busy.value || saving.value || libraryChanging.value) {
        scheduleSave()
        return
      }
      void save().catch((cause) => {
        if (!controller.signal.aborted)
          error.value =
            '保存失败，草稿仍保留：' +
            (cause instanceof Error ? cause.message : String(cause))
      })
    }, 1200)
  }
  watch(() => JSON.stringify(project.value?.document), scheduleSave)
  watch(saving, (active) => {
    if (!active) scheduleSave()
  })
  async function asset(
    body: Parameters<typeof studioApi.asset>[0],
    link: boolean,
  ) {
    const a = await studioApi.asset(body)
    if (!project.value) return
    if (!project.value.assets.some((item) => item.id === a.id))
      project.value.assets.push(a)
    if (link && !project.value.document.assets.includes(a.id))
      project.value.document.assets.push(a.id)
    await save('关联素材版本')
  }
  async function submit(options: Generation) {
    await save()
    const p = project.value!
    const payload = {
      ...options,
      video: selectedVideo.value || undefined,
      referenceVideo: selectedReference.value || undefined,
      speech: selectedSpeech.value || undefined,
    }
    const signature = JSON.stringify([p.revision, payload])
    if (attempt?.signature !== signature) attempt = { key: newId(), signature }
    const rows = await studioApi.generate(id, p.revision, attempt.key, payload)
    attempt = null
    p.jobs = [
      ...rows,
      ...p.jobs.filter((j) => !rows.some((r) => r.id === j.id)),
    ]
    notice.value = '任务已提交，可继续编辑作品'
    return rows
  }
  const preview = ref<{
    url: string
    kind: Job['kind']
    revision: number
  } | null>(null)
  async function show(job: Job, download = false) {
    const url = await studioApi.media(id, job.id, download, controller.signal)
    if (controller.signal.aborted) return
    if (download) {
      const link = document.createElement('a')
      link.href = url
      link.download = ''
      link.click()
    } else preview.value = { url, kind: job.kind, revision: job.revision }
  }
  const voices = computed(
    () =>
      catalog.value?.configurations
        .find((c) => c.id === selectedSpeech.value)
        ?.parameters.voices?.split(',') ?? [],
  )
  const linked = computed(
    () =>
      project.value?.assets.filter((a) =>
        project.value!.document.assets.includes(a.id),
      ) ?? [],
  )
  function snapshotAsset(a: StudioAsset, personal: boolean) {
    return asset(
      {
        name: a.name,
        kind: a.kind,
        description: a.description,
        voice: a.voice,
        fileId: a.fileId,
        parent: a.id,
        project: personal ? null : id,
      },
      !personal,
    )
  }
  async function initialize() {
    if (!project.value) {
      await reload()
    }
    if (!auth.can('models.use')) return
    catalog.value = await studioApi.catalog()
    const videos = catalog.value.configurations.filter(
      (c) => c.capability === 'video.generate',
    )
    const defaultId = catalog.value.defaults.find(
      (c) => c.capability === 'video.generate',
    )?.configurationId
    const chooseVideo = (reference: boolean) => {
      const available = videos.filter(
        (c) => (c.parameters.inputMode === 'reference') === reference,
      )
      return (
        (available.find((c) => c.id === defaultId) ?? available[0])?.id ?? ''
      )
    }
    selectedVideo.value = chooseVideo(false)
    selectedReference.value = chooseVideo(true)
    // 自动模式优先使用角色已试听采用的模型，未定稿的角色沿用产品默认配置。
    selectedSpeech.value = ''
  }
  onMounted(() =>
    run(initialize).finally(() => {
      if (!controller.signal.aborted) timer = setTimeout(poll, 4500)
    }),
  )
  onScopeDispose(() => {
    controller.abort()
    clearTimeout(timer)
    clearTimeout(saveTimer)
  })
  return {
    project,
    catalog,
    busy,
    saving,
    error,
    notice,
    stale,
    dirty,
    save,
    reload,
    run,
    asset,
    submit,
    show,
    preview,
    voices,
    linked,
    selectedVideo,
    selectedReference,
    selectedSpeech,
    snapshotAsset,
    importAsset,
    applyLibraryResult,
  }
}
