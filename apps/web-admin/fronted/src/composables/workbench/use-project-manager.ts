import { computed, onScopeDispose, reactive, ref, watch, type Ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import { projectApi } from '@/api/workbench/project-api'
import { conversationApi } from '@/api/workbench/conversation-api'
import { useMutation } from '@/composables/use-mutation'
import { useAuthStore } from '@/store/modules/auth-store'
import {
  availableProjectName,
  findWorkspaceProject,
  workspaceName,
} from '@/utils/workbench/sidebar-groups'
import { ApiError, errorMessage } from '@/utils/errors'
import type {
  WorkspaceConnector,
  WorkspaceProject,
} from '@/types/workbench/models'

/** 项目编辑草稿只包含可写字段；已有项目的设备和目录只能展示。 */
export interface ProjectDraft {
  name: string
  connectorId: string
  workspacePath: string
}

/** 项目写入与目录读取分离：取消目录、切设备或换号后迟到响应都不能重开窗口或触发写入。 */
export function useProjectManager(
  devices: Ref<WorkspaceConnector[]>,
  projects: Ref<WorkspaceProject[]>,
  reload: () => Promise<void>,
) {
  const auth = useAuthStore(),
    mutation = useMutation()
  const editing = ref<WorkspaceProject | 'new' | null>(null),
    draft = reactive<ProjectDraft>({
      name: '',
      connectorId: '',
      workspacePath: '',
    })
  const browser = ref(false),
    path = ref(''),
    directories = ref<{ name: string; path: string }[]>([]),
    browsing = ref(false),
    browseError = ref(''),
    resolvedDirectory = ref('')
  const online = computed(() =>
    devices.value.filter((item) => item.status === 'online'),
  )
  const canChooseDirectory = computed(
    () =>
      !!resolvedDirectory.value &&
      path.value === resolvedDirectory.value &&
      !browsing.value &&
      !browseError.value,
  )
  let alive = true,
    editorGeneration = 0,
    directoryGeneration = 0,
    nameEdited = false,
    directoryAbort: AbortController | null = null
  const lifecycle = new AbortController()
  function closeBrowser(): void {
    directoryGeneration++
    directoryAbort?.abort()
    directoryAbort = null
    browser.value = false
    browsing.value = false
    resolvedDirectory.value = ''
    directories.value = []
    browseError.value = ''
  }
  function close(): void {
    editing.value = null
  }
  function edit(value: WorkspaceProject | 'new'): void {
    if (!auth.can('projects.manage') || mutation.busy.value) return
    editorGeneration++
    closeBrowser()
    editing.value = value
    Object.assign(
      draft,
      value === 'new'
        ? {
            name: '',
            connectorId: online.value[0]?.id ?? '',
            workspacePath: '',
          }
        : {
            name: value.name,
            connectorId: value.connectorId,
            workspacePath: value.workspacePath,
          },
    )
    nameEdited = value !== 'new'
    mutation.error.value = ''
  }
  /** 受控表单更新按领域处理设备切换与自动名称，不由组件直接改嵌套属性。 */
  function updateDraft(value: Partial<ProjectDraft>): void {
    if (mutation.busy.value || !editing.value) return
    if (
      value.connectorId !== undefined &&
      value.connectorId !== draft.connectorId
    ) {
      closeBrowser()
      draft.workspacePath = ''
      if (!nameEdited) draft.name = ''
    }
    Object.assign(draft, value)
    if (value.name !== undefined) nameEdited = true
    else if (value.workspacePath !== undefined && !nameEdited) {
      const device = devices.value.find((item) => item.id === draft.connectorId)
      const existing = findWorkspaceProject(
        projects.value,
        draft.connectorId,
        draft.workspacePath,
        device?.deviceOs,
      )
      draft.name = draft.workspacePath.trim()
        ? availableProjectName(
            existing?.name ?? workspaceName(draft.workspacePath),
            projects.value,
            existing?.id,
          )
        : ''
    }
    mutation.error.value = ''
  }
  function updatePath(value: string): void {
    // 正在读取旧路径时的新输入必须取消旧请求，不能被迟到结果覆盖。
    directoryGeneration++
    directoryAbort?.abort()
    directoryAbort = null
    browsing.value = false
    path.value = value
    resolvedDirectory.value = ''
    directories.value = []
    browseError.value = ''
  }
  async function browse(next = draft.workspacePath || '~'): Promise<void> {
    if (
      !draft.connectorId ||
      editing.value !== 'new' ||
      !auth.can('projects.manage')
    )
      return
    const generation = editorGeneration,
      identity = auth.generation,
      connectorId = draft.connectorId,
      request = ++directoryGeneration
    directoryAbort?.abort()
    const abort = new AbortController()
    directoryAbort = abort
    browser.value = true
    browsing.value = true
    path.value = next
    resolvedDirectory.value = ''
    browseError.value = ''
    directories.value = []
    const current = () =>
      alive &&
      !abort.signal.aborted &&
      identity === auth.generation &&
      generation === editorGeneration &&
      request === directoryGeneration &&
      connectorId === draft.connectorId &&
      browser.value
    try {
      const result = await projectApi.directory(
        connectorId,
        next,
        devices.value.find((item) => item.id === connectorId)?.deviceOs ===
          'windows',
        abort.signal,
      )
      if (!current()) return
      path.value = result.path
      resolvedDirectory.value = result.path
      directories.value = result.directories
    } catch (cause) {
      if (current()) browseError.value = errorMessage(cause)
    } finally {
      if (current()) browsing.value = false
    }
  }
  function chooseDirectory(): void {
    if (!canChooseDirectory.value || editing.value !== 'new') return
    updateDraft({ workspacePath: resolvedDirectory.value })
    closeBrowser()
  }
  async function save(): Promise<void> {
    const value = editing.value
    if (!value || !auth.can('projects.manage') || mutation.busy.value) return
    const body = {
      name: draft.name.trim(),
      connectorId: draft.connectorId,
      workspacePath: draft.workspacePath.trim(),
    }
    if (!body.name || !body.workspacePath || !body.connectorId) {
      mutation.error.value = '请选择设备并填写项目名称与工作目录'
      return
    }
    if (
      value === 'new' &&
      !online.value.some((item) => item.id === body.connectorId)
    ) {
      mutation.error.value = '请选择在线设备'
      return
    }
    const generation = editorGeneration,
      identity = auth.generation,
      deviceOs = devices.value.find(
        (item) => item.id === body.connectorId,
      )?.deviceOs
    const current = () =>
      alive &&
      generation === editorGeneration &&
      identity === auth.generation &&
      auth.can('projects.manage') &&
      editing.value === value
    let written = false
    const success = await mutation.run(async () => {
      if (value === 'new' && body.workspacePath.startsWith('~')) {
        const directory = await projectApi.directory(
          body.connectorId,
          body.workspacePath,
          deviceOs === 'windows',
        )
        if (!current()) return
        if (!directory.path) throw new Error('请选择具体工作目录')
        body.workspacePath = directory.path
        draft.workspacePath = directory.path
      }
      const existing =
        value === 'new'
          ? findWorkspaceProject(
              projects.value,
              body.connectorId,
              body.workspacePath,
              deviceOs,
            )
          : undefined
      const name = availableProjectName(
        body.name,
        projects.value,
        value === 'new' ? existing?.id : value.id,
      )
      if (name !== body.name) {
        draft.name = name
        throw new Error('同名项目已存在，已调整名称，请确认后重新保存')
      }
      if (existing && existing.name !== name) {
        try {
          await ElMessageBox.confirm(
            `工作目录“${body.workspacePath}”已属于项目“${existing.name}”。继续将按名称“${name}”保存此工作区，是否继续？`,
            '工作目录已关联项目',
            {
              confirmButtonText: '确认使用此工作目录',
              cancelButtonText: '返回修改',
              type: 'warning',
            },
          )
        } catch {
          return
        }
      }
      if (!current()) return
      try {
        await projectApi.save(body, value === 'new' ? undefined : value.id)
      } catch (cause) {
        if (
          current() &&
          cause instanceof ApiError &&
          cause.code === 'project_name_conflict'
        ) {
          draft.name = availableProjectName(
            name,
            [...projects.value, { id: '', name }],
            value === 'new' ? existing?.id : value.id,
          )
          throw new Error('同名项目已存在，已调整名称，请确认后重新保存', {
            cause,
          })
        }
        throw cause
      }
      written = true
    })
    if (success && written && current()) {
      editing.value = null
      await reload()
    }
  }
  async function action(
    value: WorkspaceProject,
    action: 'edit' | 'pin' | 'archive' | 'restore',
  ): Promise<void> {
    if (!auth.can('projects.manage')) return
    const identity = auth.generation
    if (action === 'edit') return edit(value)
    if (action !== 'pin') {
      try {
        await ElMessageBox.confirm(
          `${action === 'archive' ? '归档' : '恢复'}项目“${value.name}”的全部会话？`,
          action === 'archive' ? '归档全部会话' : '恢复全部会话',
          { type: 'warning' },
        )
      } catch {
        return
      }
    }
    if (!alive || identity !== auth.generation || !auth.can('projects.manage'))
      return
    if (
      await mutation.run(() =>
        action === 'pin'
          ? projectApi.pin(value.id, !value.pinned)
          : projectApi.archive(value.id, action === 'archive'),
      )
    )
      await reload()
  }
  async function markAllRead(): Promise<void> {
    if (!auth.can('sessions.read') || mutation.busy.value) return
    const identity = auth.generation
    const current = () =>
      alive && identity === auth.generation && auth.can('sessions.read')
    if (
      (await mutation.run(async () => {
        // 侧栏分页不改变“全部”含义：包括未加载和归档会话，不能只提交可见前一百条。
        const inventory = await conversationApi.inventory(lifecycle.signal)
        if (!current()) return
        const ids = [
          ...new Set(
            inventory.sessions
              .filter((item) => item.unread)
              .map((item) => item.id),
          ),
        ]
        // 旧接口单批最多一千项；每批前重新检查身份，取消后不继续后续批次。
        for (let offset = 0; offset < ids.length; offset += 1000) {
          if (!current()) return
          await projectApi.read(ids.slice(offset, offset + 1000))
        }
      })) &&
      current()
    )
      await reload()
  }
  watch(
    editing,
    () => {
      editorGeneration++
      closeBrowser()
    },
    { flush: 'sync' },
  )
  watch(
    () => auth.generation,
    () => {
      editing.value = null
      Object.assign(draft, { name: '', connectorId: '', workspacePath: '' })
    },
    { flush: 'sync' },
  )
  onScopeDispose(() => {
    alive = false
    lifecycle.abort()
    editorGeneration++
    closeBrowser()
  })
  return {
    devices,
    auth,
    mutation,
    editing,
    draft,
    online,
    browser,
    path,
    directories,
    browsing,
    browseError,
    canChooseDirectory,
    edit,
    close,
    closeBrowser,
    updateDraft,
    updatePath,
    save,
    browse,
    chooseDirectory,
    action,
    markAllRead,
  }
}
