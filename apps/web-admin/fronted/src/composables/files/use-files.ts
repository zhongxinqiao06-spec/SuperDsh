import { computed, onScopeDispose, reactive, ref, watch } from 'vue'
import { filesApi, downloadFile } from '@/api/files/files-api'
import { uploadFile } from '@/api/files/upload-api'
import { storageApi } from '@/api/storage/storage-api'
import { useAuthStore } from '@/store/modules/auth-store'
import { useResource } from '@/composables/use-resource'
import { useMutation } from '@/composables/use-mutation'
import { previewKind } from '@/utils/files/presentation'
import type { FileEntry, FileFilter } from '@/types/files/files'

/** 文件列表与传输状态属于当前页面；停止传输保留服务端可续传分片。 */
export function useFiles() {
  const auth = useAuthStore(),
    mutation = useMutation(),
    transfer = useMutation()
  const filter = reactive<FileFilter>({
      page: 1,
      pageSize: 10,
      search: '',
      deleted: false,
      category: '',
    }),
    query = ref('')
  const resource = useResource((signal) => filesApi.list({ ...filter }, signal))
  const storage = useResource((signal) =>
    auth.can('storage.manage')
      ? storageApi.settings(signal)
      : Promise.resolve(null),
  )
  const uploadOpen = ref(false),
    selected = ref<File | null>(null),
    previous = ref<FileEntry | null>(null),
    progress = ref(0)
  const versionTarget = ref<FileEntry | null>(null),
    versions = useResource((signal) =>
      versionTarget.value
        ? filesApi.versions(versionTarget.value.id, signal)
        : Promise.resolve({ items: [] }),
    )
  const migrating = ref<FileEntry | null>(null),
    targetStorage = ref('')
  const preview = ref<FileEntry | null>(null),
    previewUrl = ref(''),
    previewText = ref(''),
    previewType = computed(() =>
      preview.value ? previewKind(preview.value.mediaType) : null,
    )
  let controller: AbortController | null = null,
    alive = true
  const downloadTimers = new Map<string, ReturnType<typeof setTimeout>>()
  function stop(): void {
    controller?.abort()
    controller = null
  }
  function closePreview(): void {
    stop()
    if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
    previewUrl.value = ''
    previewText.value = ''
    preview.value = null
  }
  function clear(): void {
    stop()
    closePreview()
    selected.value = null
    previous.value = null
    uploadOpen.value = false
    versionTarget.value = null
    migrating.value = null
    for (const [url, timer] of downloadTimers) {
      clearTimeout(timer)
      URL.revokeObjectURL(url)
    }
    downloadTimers.clear()
  }
  watch(() => auth.generation, clear)
  onScopeDispose(() => {
    alive = false
    clear()
  })
  watch(
    () => [
      filter.page,
      filter.pageSize,
      filter.search,
      filter.deleted,
      filter.category,
    ],
    () => {
      void resource.reload()
    },
  )
  watch(versionTarget, () => {
    void versions.reload()
  })
  // 与旧文件库保持输入即筛选，分页回到第一页；实际请求由筛选状态订阅统一发起。
  watch(query, (value) => {
    filter.page = 1
    filter.search = value.trim()
  })
  function search(): void {
    filter.page = 1
    filter.search = query.value.trim()
    void resource.reload()
  }
  function toggleTrash(): void {
    filter.page = 1
    filter.deleted = !filter.deleted
  }
  function openUpload(file?: FileEntry): void {
    previous.value = file ?? null
    selected.value = null
    progress.value = 0
    transfer.error.value = ''
    uploadOpen.value = true
  }
  function choose(event: Event): void {
    selected.value =
      event.target instanceof HTMLInputElement
        ? (event.target.files?.[0] ?? null)
        : null
  }
  async function upload(): Promise<void> {
    const file = selected.value
    if (!file || !auth.can('files.write')) return
    stop()
    controller = new AbortController()
    const signal = controller.signal
    if (
      await transfer.run(() =>
        uploadFile(
          file,
          signal,
          (value) => {
            if (alive && !signal.aborted) progress.value = value
          },
          previous.value?.id,
        ),
      )
    ) {
      uploadOpen.value = false
      selected.value = null
      previous.value = null
      await resource.reload()
    }
  }
  async function download(file: FileEntry): Promise<void> {
    const generation = auth.generation
    stop()
    controller = new AbortController()
    const signal = controller.signal
    await transfer.run(async () => {
      const blob = await downloadFile(file, signal)
      if (!alive || signal.aborted || auth.generation !== generation) return
      const url = URL.createObjectURL(blob),
        link = document.createElement('a')
      link.href = url
      link.download = file.name
      link.click()
      downloadTimers.set(
        url,
        setTimeout(() => {
          URL.revokeObjectURL(url)
          downloadTimers.delete(url)
        }, 1000),
      )
    })
  }
  async function showPreview(file: FileEntry): Promise<void> {
    if (!previewKind(file.mediaType)) return
    closePreview()
    preview.value = file
    controller = new AbortController()
    const signal = controller.signal,
      generation = auth.generation
    await transfer.run(async () => {
      const blob = await downloadFile(file, signal)
      const text =
        previewKind(file.mediaType) === 'text'
          ? await blob.slice(0, 1024 * 1024).text()
          : ''
      if (
        !alive ||
        signal.aborted ||
        generation !== auth.generation ||
        preview.value?.id !== file.id
      )
        return
      previewText.value = text
      previewUrl.value = URL.createObjectURL(blob)
    })
  }
  async function trash(file: FileEntry): Promise<void> {
    if (!auth.can('files.write') || (!file.deletedAt && file.references.length))
      return
    if (
      await mutation.run(() => filesApi.trash(file.id, Boolean(file.deletedAt)))
    ) {
      await resource.reload()
    }
  }
  async function migrate(): Promise<void> {
    const file = migrating.value,
      destination = targetStorage.value
    if (!file || !destination) return
    if (await mutation.run(() => filesApi.migrate(file.id, destination))) {
      migrating.value = null
      await resource.reload()
    }
  }
  /** 切换迁移目标时同时清空上一次存储选择，模板只发送操作意图。 */
  function openMigration(file: FileEntry): void {
    migrating.value = file
    targetStorage.value = ''
  }
  return {
    auth,
    filter,
    query,
    resource,
    storage,
    mutation,
    transfer,
    uploadOpen,
    selected,
    previous,
    progress,
    versionTarget,
    versions,
    migrating,
    targetStorage,
    preview,
    previewUrl,
    previewText,
    previewType,
    search,
    toggleTrash,
    openUpload,
    choose,
    upload,
    stop,
    download,
    showPreview,
    closePreview,
    trash,
    migrate,
    openMigration,
  }
}
