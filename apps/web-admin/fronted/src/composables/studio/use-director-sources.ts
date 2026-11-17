import { createUuid } from '@/utils/uuid'
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue'
import { uploadFile } from '@/api/files/upload-api'
import { studioApi } from '@/api/studio/studio-api'
import { directorContextApi } from '@/api/studio/director-context-api'
import { ApiError } from '@/utils/errors'
import type { StudioAsset } from '@/types/studio/studio'
import type {
  DirectorCapabilities,
  DirectorContextResult,
  DirectorEvidence,
  DirectorUpload,
} from '@/types/studio/director-context'

/** 上传、形象库引用和 AI 资料准备共享一次确认；失败保留输入，重试复用请求身份。 */
export function useDirectorSources(options: {
  project: string
  active: () => boolean
  revision: () => number
  save: () => Promise<void>
  reload: () => Promise<void>
  canReadAssets: () => boolean
  canUpload: () => boolean
}) {
  const uploads = ref<DirectorUpload[]>([])
  const assets = ref<StudioAsset[]>([])
  const selected = ref<string[]>([])
  const capabilities = ref<DirectorCapabilities>()
  const evidence = ref<DirectorEvidence>()
  const analyzeImages = ref(true),
    research = ref(false),
    researchQuery = ref('')
  const uploading = ref(false),
    preparing = ref(false),
    loading = ref(false)
  const error = ref(''),
    progress = ref('')
  const libraryOpen = ref(false)
  const abort = new AbortController()
  const hasSources = computed(
    () => !!(uploads.value.length || selected.value.length || research.value),
  )
  const selectedAssets = computed(() =>
    assets.value.filter((asset) => selected.value.includes(asset.id)),
  )
  const references = computed(
    () => selected.value.length + uploads.value.length,
  )
  let attempt:
    | {
        signature: string
        requestKey: string
        revision: number
        result?: DirectorContextResult
      }
    | undefined

  watch(
    options.active,
    async (active) => {
      if (!active || capabilities.value) return
      try {
        capabilities.value = await directorContextApi.capabilities(
          options.project,
          abort.signal,
        )
      } catch (cause) {
        if (!abort.signal.aborted)
          error.value = '辅助能力暂时无法读取，可先用文字起草。' + String(cause)
      }
    },
    { immediate: true },
  )

  async function openLibrary() {
    libraryOpen.value = true
    if (!options.canReadAssets()) return
    loading.value = true
    error.value = ''
    try {
      const items = await studioApi.library()
      if (!abort.signal.aborted)
        assets.value = items.filter(
          (item) =>
            item.project === null && ['character', 'image'].includes(item.kind),
        )
    } catch (cause) {
      if (!abort.signal.aborted) error.value = String(cause)
    } finally {
      loading.value = false
    }
  }
  /** 资料输入由所属用例更新，展示组件只通过事件调用，不直接修改传入状态。 */
  function setLibraryOpen(value: boolean) {
    libraryOpen.value = value
  }
  function setAnalyzeImages(value: boolean) {
    analyzeImages.value = value
  }
  function setResearch(value: boolean) {
    research.value = value
  }
  function setResearchQuery(value: string) {
    researchQuery.value = value
  }
  function setUploadName(fileId: string, value: string) {
    const item = uploads.value.find((entry) => entry.file.fileId === fileId)
    if (item) item.name = value
  }
  function toggleAsset(id: string) {
    if (selected.value.includes(id))
      selected.value = selected.value.filter((value) => value !== id)
    else if (selected.value.length < 4) selected.value.push(id)
  }
  async function upload(files: File[]) {
    if (uploading.value || !options.canUpload()) return
    const available = 4 - uploads.value.length
    if (files.length > available) {
      error.value = '每次最多上传 4 张参考图，请减少后重试。'
      return
    }
    if (
      files.some(
        (file) =>
          !['image/jpeg', 'image/png', 'image/webp'].includes(file.type),
      )
    ) {
      error.value = '请选择 JPG、PNG 或 WebP 图片。'
      return
    }
    uploading.value = true
    error.value = ''
    try {
      for (const file of files) {
        const saved = await uploadFile(file, abort.signal)
        abort.signal.throwIfAborted()
        const name = file.name.replace(/\.[^.]+$/u, '')
        uploads.value.push({
          file: saved,
          name: /^(codex-clipboard|image|screenshot)[-_\d]/iu.test(name)
            ? '参考形象 ' + (uploads.value.length + 1)
            : name.slice(0, 120),
          preview: URL.createObjectURL(file),
        })
      }
    } catch (cause) {
      if (!abort.signal.aborted)
        error.value = '图片上传失败，文字与已上传的图片已保留。' + String(cause)
    } finally {
      uploading.value = false
    }
  }
  function removeUpload(index: number) {
    const [removed] = uploads.value.splice(index, 1)
    if (removed) URL.revokeObjectURL(removed.preview)
  }
  async function prepare(
    fallbackQuery: string,
  ): Promise<DirectorContextResult | undefined> {
    if (!hasSources.value) return
    if (uploading.value) throw new Error('请等待图片上传完成。')
    if (research.value && !capabilities.value?.research.available)
      throw new Error('联网查询尚不可用，可关闭查询后继续起草。')
    if (uploads.value.some((item) => !item.name.trim()))
      throw new Error('请为上传的形象填写名称。')
    const input = {
      assetIds: [...selected.value],
      uploads: uploads.value.map((item) => ({
        fileId: item.file.fileId,
        name: item.name.trim(),
      })),
      analyzeImages: !!(
        references.value &&
        analyzeImages.value &&
        capabilities.value?.vision.available
      ),
      ...(research.value
        ? { researchQuery: researchQuery.value.trim() || fallbackQuery.trim() }
        : {}),
    }
    if (research.value && !input.researchQuery)
      throw new Error('请填写想了解的地点或主题。')
    const signature = JSON.stringify(input)
    // 已成功准备的上下文在工具恢复/发送重试时复用，不重复解析图片和查询。
    if (attempt?.signature === signature && attempt.result) {
      await options.save()
      await options.reload()
      return attempt.result
    }
    preparing.value = true
    progress.value = input.analyzeImages
      ? '正在理解参考形象并准备故事资料'
      : research.value
        ? '正在查询故事相关资料'
        : '正在关联本片参考形象'
    error.value = ''
    try {
      await options.save()
      await nextTick()
      if (attempt?.signature !== signature)
        attempt = {
          signature,
          requestKey: createUuid(),
          revision: options.revision(),
        }
      const result = await directorContextApi.prepare(
        options.project,
        {
          ...input,
          requestKey: attempt.requestKey,
          revision: attempt.revision,
        },
        abort.signal,
      )
      attempt.result = result
      evidence.value = result.evidence
      await options.reload()
      progress.value = '参考资料已准备，正在交给导演起草。'
      return result
    } catch (cause) {
      progress.value = ''
      if (
        cause instanceof ApiError &&
        cause.code === 'director_context_conflict'
      ) {
        await options.reload()
        await nextTick()
        if (attempt) attempt.revision = options.revision()
      }
      throw cause
    } finally {
      preparing.value = false
    }
  }
  function submitted() {
    uploads.value.forEach((item) => URL.revokeObjectURL(item.preview))
    uploads.value = []
    selected.value = []
    research.value = false
    researchQuery.value = ''
    attempt = undefined
    progress.value = ''
  }
  onScopeDispose(() => {
    abort.abort()
    uploads.value.forEach((item) => URL.revokeObjectURL(item.preview))
  })
  return {
    uploads,
    assets,
    selected,
    selectedAssets,
    capabilities,
    evidence,
    analyzeImages,
    research,
    researchQuery,
    uploading,
    preparing,
    loading,
    error,
    progress,
    libraryOpen,
    hasSources,
    references,
    openLibrary,
    setLibraryOpen,
    setAnalyzeImages,
    setResearch,
    setResearchQuery,
    setUploadName,
    toggleAsset,
    upload,
    removeUpload,
    prepare,
    submitted,
  }
}
