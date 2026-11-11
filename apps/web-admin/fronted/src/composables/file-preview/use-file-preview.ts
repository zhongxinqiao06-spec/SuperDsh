import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import {
  onBeforeRouteLeave,
  onBeforeRouteUpdate,
  useRoute,
  useRouter,
} from 'vue-router'
import { previewApi } from '@/api/file-preview/preview-api'
import type { WorkspaceEntry } from '@/api/workspace-files/workspace-api'
import type { PreviewSession } from '@/types/file-preview/preview'
import {
  previewLocation,
  isPreviewText,
} from '@/utils/file-preview/preview-location'
import { previewKind } from '@/utils/files/presentation'
import { errorMessage } from '@/utils/errors'
import { useAuthStore } from '@/store/modules/auth-store'

/** 独立窗口释放请求、Blob URL 与身份代际；失败保存保留编辑草稿。 */
export function useFilePreview() {
  const route = useRoute(),
    router = useRouter(),
    auth = useAuthStore()
  const location = computed(() => previewLocation(route.query))
  const loading = ref(false),
    error = ref(''),
    saving = ref(false),
    saveError = ref('')
  const source = shallowRef<Blob | null>(null),
    objectUrl = ref(''),
    content = ref(''),
    original = ref(''),
    digest = ref('')
  const entries = shallowRef<WorkspaceEntry[] | null>(null),
    editing = ref(false),
    truncated = ref(false)
  const name = computed(
    () =>
      location.value.name ||
      location.value.path.split(/[/\\]/).pop() ||
      '文件预览',
  )
  const kind = computed(() => {
    const type =
      (source.value?.type || location.value.mediaType).split(';')[0] ?? ''
    return isPreviewText(type, name.value) ? 'text' : previewKind(type)
  })
  const dirty = computed(() => content.value !== original.value)
  const writable = computed(
    () =>
      !location.value.previewToken &&
      !location.value.sourceUrl &&
      kind.value === 'text' &&
      !truncated.value &&
      auth.can('files.write') &&
      Boolean(digest.value),
  )
  let controller: AbortController | null = null,
    generation = 0,
    session: PreviewSession | null = null,
    sessionToken = '',
    hydrating = false

  function release(): void {
    if (objectUrl.value) URL.revokeObjectURL(objectUrl.value)
    objectUrl.value = ''
    source.value = null
  }
  async function load(): Promise<void> {
    const current = ++generation
    controller?.abort()
    controller = new AbortController()
    const signal = controller.signal,
      target = location.value
    release()
    loading.value = true
    error.value = ''
    saveError.value = ''
    entries.value = null
    editing.value = false
    digest.value = ''
    content.value = ''
    original.value = ''
    truncated.value = false
    try {
      if (target.previewToken) {
        if (sessionToken !== target.previewToken) {
          session = null
          sessionToken = target.previewToken
        }
        if (!session)
          session = await previewApi.exchange(target.previewToken, signal)
      } else if (!target.sourceUrl) {
        hydrating = true
        try {
          await auth.hydrate()
        } finally {
          hydrating = false
        }
        if (!target.connectorId || !target.path)
          throw new Error('缺少设备或文件路径，请重新打开预览')
        if (!auth.authenticated) throw new Error('请先登录后重新打开文件')
      }
      const blob = await previewApi.load(
        target,
        target.previewToken ? session : null,
        signal,
      )
      if (current !== generation || signal.aborted) return
      source.value = blob
      if (
        isPreviewText(blob.type.split(';')[0] ?? '', target.name || target.path)
      ) {
        truncated.value = blob.size > 1_000_000
        const text = await (
          truncated.value ? blob.slice(0, 1_000_000) : blob
        ).text()
        if (current !== generation || signal.aborted) return
        original.value = text
        content.value = text
        if (
          !target.previewToken &&
          !target.sourceUrl &&
          !truncated.value &&
          auth.can('files.write')
        ) {
          const detail = await previewApi.text(
            target.connectorId,
            target.path,
            signal,
            target.root,
          )
          if (current !== generation || signal.aborted) return
          content.value = detail.content
          original.value = detail.content
          digest.value = detail.sha256
        }
      }
      if (current === generation && !signal.aborted)
        objectUrl.value = URL.createObjectURL(blob)
    } catch (cause) {
      if (current !== generation || signal.aborted) return
      if (
        !target.previewToken &&
        !target.sourceUrl &&
        target.connectorId &&
        auth.authenticated
      ) {
        try {
          const directory = await previewApi.list(
            target.connectorId,
            target.path,
            signal,
            target.root,
          )
          if (current === generation && !signal.aborted)
            entries.value = directory.entries
          return
        } catch {
          /* 目录探测失败保留原文件读取错误，不伪装为空目录。 */
        }
      }
      error.value = errorMessage(cause)
    } finally {
      if (current === generation) loading.value = false
    }
  }
  async function save(): Promise<void> {
    if (!writable.value || saving.value || !dirty.value) return
    const current = generation,
      target = location.value,
      submitted = content.value
    saving.value = true
    saveError.value = ''
    try {
      const result = await previewApi.save(
        target.connectorId,
        target.path,
        submitted,
        digest.value,
        target.root,
      )
      if (current !== generation) return
      digest.value = result.sha256
      original.value = submitted
      if (objectUrl.value) URL.revokeObjectURL(objectUrl.value)
      source.value = new Blob([submitted], {
        type: source.value?.type || 'text/plain',
      })
      objectUrl.value = URL.createObjectURL(source.value)
      if (!dirty.value) editing.value = false
    } catch (cause) {
      if (current === generation) saveError.value = errorMessage(cause)
    } finally {
      saving.value = false
    }
  }
  function download(): void {
    if (!objectUrl.value) return
    const anchor = document.createElement('a')
    anchor.href = objectUrl.value
    anchor.download = name.value
    anchor.click()
  }
  function open(entry: WorkspaceEntry): void {
    void router.push({
      path: '/preview',
      query: { ...route.query, path: entry.path, name: entry.name },
    })
  }
  function leaving(): boolean {
    return !dirty.value || window.confirm('文件尚未保存，确认离开并放弃修改？')
  }
  function unload(event: BeforeUnloadEvent): void {
    if (dirty.value) {
      event.preventDefault()
      event.returnValue = ''
    }
  }
  onBeforeRouteLeave(leaving)
  onBeforeRouteUpdate(leaving)
  window.addEventListener('beforeunload', unload)
  watch(
    () => route.fullPath,
    () => {
      void load()
    },
    { immediate: true },
  )
  watch(
    () => auth.generation,
    () => {
      if (hydrating) return
      ++generation
      controller?.abort()
      release()
      entries.value = null
      content.value = ''
      original.value = ''
      digest.value = ''
      error.value = '账号状态已变化，请重新打开预览'
    },
  )
  onScopeDispose(() => {
    ++generation
    controller?.abort()
    release()
    window.removeEventListener('beforeunload', unload)
  })
  return {
    location,
    name,
    loading,
    error,
    saving,
    saveError,
    objectUrl,
    source,
    kind,
    content,
    entries,
    editing,
    dirty,
    truncated,
    writable,
    load,
    save,
    download,
    open,
  }
}
