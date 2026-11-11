import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import {
  workspaceApi,
  type WorkspaceEntry,
} from '@/api/workspace-files/workspace-api'
import { errorMessage } from '@/utils/errors'
import { sessionController } from '@/store/session-controller'

/** 编辑草稿与服务端版本分离，412 冲突时保留本地内容供用户比较。 */
export function useWorkspaceFiles(
  connector: Ref<string>,
  root: Ref<string | undefined> = ref(),
) {
  const path = ref('.'),
    entries = ref<WorkspaceEntry[]>([]),
    selected = ref('')
  const content = ref(''),
    original = ref(''),
    revision = ref(''),
    error = ref(''),
    busy = ref(false)
  const dirty = computed(() => content.value !== original.value)
  const breadcrumbs = computed(() => {
    const normalized = path.value.replaceAll('\\', '/')
    const anchor = (root.value ?? '').replaceAll('\\', '/').replace(/\/$/u, '')
    const relative =
      anchor && normalized.startsWith(anchor)
        ? normalized.slice(anchor.length).replace(/^\//u, '')
        : normalized === '.'
          ? ''
          : normalized
    const parts = relative.split('/').filter(Boolean)
    return [
      { name: '工作区', path: root.value || '.' },
      ...parts.map((name, index) => ({
        name,
        path: `${anchor ? anchor + '/' : ''}${parts.slice(0, index + 1).join('/')}`,
      })),
    ]
  })
  const abort = new AbortController()
  let generation = 0
  let accountGeneration = sessionController.generation
  async function discard(): Promise<boolean> {
    if (!dirty.value) return true
    try {
      await ElMessageBox.confirm(
        '当前文件有未保存内容，是否放弃这些修改？',
        '未保存修改',
        { type: 'warning' },
      )
      return true
    } catch {
      return false
    }
  }
  async function run(action: () => Promise<void>): Promise<void> {
    error.value = ''
    busy.value = true
    try {
      await action()
    } catch (cause) {
      if (!abort.signal.aborted) error.value = errorMessage(cause)
    } finally {
      busy.value = false
    }
  }
  async function list(next = path.value): Promise<void> {
    const current = ++generation,
      device = connector.value
    await run(async () => {
      const value = await workspaceApi.list(
        device,
        next,
        abort.signal,
        root.value,
      )
      if (current === generation && connector.value === device) {
        entries.value = value.entries
        path.value = value.path
      }
    })
  }
  async function open(entry: WorkspaceEntry): Promise<void> {
    if (entry.isDirectory || entry.type === 'directory') {
      await list(entry.path)
      return
    }
    if (!(await discard())) return
    const current = ++generation,
      device = connector.value
    await run(async () => {
      const value = await workspaceApi.read(
        device,
        entry.path,
        abort.signal,
        root.value,
      )
      if (current === generation && connector.value === device) {
        selected.value = value.path
        content.value = value.content
        original.value = value.content
        revision.value = value.sha256
      }
    })
  }
  async function save(): Promise<void> {
    const device = connector.value,
      file = selected.value,
      text = content.value
    await run(async () => {
      const value = await workspaceApi.write(
        device,
        file,
        text,
        revision.value,
        root.value,
      )
      if (device === connector.value && file === selected.value) {
        original.value = text
        revision.value = value.sha256
        await list()
      }
    })
  }
  async function create(): Promise<void> {
    if (!(await discard())) return
    await run(async () => {
      const value = await ElMessageBox.prompt(
        '输入相对于工作区的文件路径',
        '新建文本文件',
      )
      selected.value = value.value
      content.value = ''
      original.value = ''
      revision.value = ''
    })
  }
  async function download(entry: WorkspaceEntry): Promise<void> {
    await run(async () => {
      const response = await workspaceApi.download(
        connector.value,
        entry.path,
        abort.signal,
        root.value,
      )
      if (abort.signal.aborted) return
      const url = URL.createObjectURL(response)
      const link = document.createElement('a')
      link.href = url
      link.download = entry.name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    })
  }
  watch(
    [connector, root],
    () => {
      generation++
      entries.value = []
      selected.value = ''
      content.value = ''
      original.value = ''
      path.value = '.'
      if (connector.value) void list()
    },
    { immediate: true },
  )
  async function preview(entry: WorkspaceEntry): Promise<void> {
    const popup = window.open('', '_blank')
    if (popup) popup.opener = null
    await run(async () => {
      try {
        const value = await workspaceApi.previewToken(
          connector.value,
          entry.path,
          root.value,
        )
        if (abort.signal.aborted) {
          popup?.close()
          return
        }
        const url = new URL(location.href)
        url.pathname = '/'
        url.search = ''
        url.hash = `/preview?token=${encodeURIComponent(value.previewToken)}`
        if (popup) popup.location.replace(url.toString())
        else throw new Error('浏览器阻止了预览窗口，请允许此站点打开新窗口')
      } catch (cause) {
        popup?.close()
        throw cause
      }
    })
  }
  function beforeUnload(event: BeforeUnloadEvent) {
    if (dirty.value) {
      event.preventDefault()
      event.returnValue = ''
    }
  }
  window.addEventListener('beforeunload', beforeUnload)
  const unsubscribe = sessionController.subscribe(() => {
    if (accountGeneration === sessionController.generation) return
    accountGeneration = sessionController.generation
    generation++
    entries.value = []
    selected.value = ''
    content.value = ''
    original.value = ''
  })
  onScopeDispose(() => {
    abort.abort()
    generation++
    unsubscribe()
    window.removeEventListener('beforeunload', beforeUnload)
  })
  return {
    path,
    entries,
    selected,
    content,
    dirty,
    error,
    busy,
    list,
    open,
    save,
    create,
    download,
    discard,
    preview,
    breadcrumbs,
  }
}
