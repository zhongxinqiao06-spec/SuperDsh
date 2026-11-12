import { createUuid } from '@/utils/uuid'
import { computed, onMounted, onScopeDispose, ref, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import { useRoute, useRouter } from 'vue-router'
import { conversationApi } from '@/api/workbench/conversation-api'
import { consumeAgentTrial } from '@/api/workbench/trial'
import { uploadFile } from '@/api/files/upload-api'
import { useDraftStore } from '@/store/modules/draft-store'
import { useRuntimeStore } from '@/store/modules/runtime-store'
import { useAuthStore } from '@/store/modules/auth-store'
import { sessionController } from '@/store/session-controller'
import { errorMessage } from '@/utils/errors'
import { mergeSessionSnapshot, mergeTimeline } from '@/utils/workbench/timeline'
import { newSessionTarget } from '@/utils/workbench/new-session-target'
import {
  selectionIdForModelCatalog,
  selectionIdForPermissionCatalog,
} from '@/utils/workbench/catalog'
import {
  canComposeSession,
  canControlSession,
} from '@/utils/workbench/session-access'
import { useSessionStream } from '@/composables/workbench/use-session-stream'
import { useRuntimeSelections } from '@/composables/workbench/use-runtime-selections'
import { useSessionLifecycle } from '@/composables/workbench/use-session-lifecycle'
import { useRuntimeReadiness } from '@/composables/workbench/use-runtime-readiness'
import type {
  RuntimeCatalog,
  SessionSnapshot,
  TimelineItem,
  WorkspaceConnector,
  WorkspaceProject,
  WorkspaceSession,
  SessionAction,
} from '@/types/workbench/models'
import type { AgentDefinition } from '@/types/agents/agents'

/** 工作台用例负责草稿、请求代际和订阅；展示组件只传入用户操作。 */
export function useWorkbench() {
  const route = useRoute(),
    router = useRouter()
  const drafts = useDraftStore()
  const runtime = useRuntimeStore()
  const auth = useAuthStore()
  const selected = ref(''),
    draftKey = ref('new-session'),
    agentId = ref('')
  const devices = ref<WorkspaceConnector[]>([]),
    projects = ref<WorkspaceProject[]>([]),
    sessions = ref<WorkspaceSession[]>([])
  const agents = ref<AgentDefinition[]>([]),
    nextCursor = ref<string | null>(null)
  const project = ref(''),
    search = ref(''),
    archived = ref(false),
    snapshot = ref<SessionSnapshot | null>(null)
  const busy = ref(false),
    takingOver = ref(false),
    sending = ref(false),
    responding = ref(false),
    error = ref(''),
    uploadProgress = ref(0),
    shareUrl = ref('')
  const models = ref<RuntimeCatalog>({}),
    permissions = ref<RuntimeCatalog>({})
  const draft = computed(() => drafts.draft(selected.value || draftKey.value))
  const permission = computed({
    get: () => draft.value.permissionId ?? '',
    set: (value: string) => {
      draft.value.permissionId = value
    },
  })
  const pending = ref<{ sessionId: string; item: TimelineItem } | null>(null)
  const timeline = computed(() => {
    const items = snapshot.value?.timeline.items ?? []
    return pending.value?.sessionId === selected.value
      ? [...items, pending.value.item]
      : items
  })
  const abort = new AbortController()
  let selectionGeneration = 0
  let snapshotRequest = 0
  let accountGeneration = sessionController.generation
  let listingGeneration = 0,
    catalogGeneration = 0
  const stream = useSessionStream(selected, snapshot, refreshSnapshot)
  // 实时状态也回写侧栏，不能只在创建时刷新列表，遗留 starting/running 标签。
  watch(
    () => snapshot.value?.session,
    (value) => {
      if (!value) return
      const index = sessions.value.findIndex((item) => item.id === value.id)
      if (index >= 0)
        sessions.value[index] = { ...sessions.value[index]!, ...value }
    },
    { deep: true },
  )
  const runtimeReadiness = useRuntimeReadiness(
    runtime,
    async () => {
      await reload()
      await loadCatalogs()
    },
    abort.signal,
  )
  const lifecycle = useSessionLifecycle({
    selected,
    snapshot,
    sessions,
    signal: abort.signal,
    run,
    refresh: refreshSnapshot,
    reload,
    fresh,
    removeDraft: drafts.remove,
    report: (message) => {
      error.value = message
    },
  })
  const runtimeSelections = useRuntimeSelections({
    selected,
    snapshot,
    draft,
    models,
    permissions,
    permission,
    refresh: refreshSnapshot,
    report: (message) => {
      error.value = message
    },
  })

  async function run(action: () => Promise<void>): Promise<void> {
    const identity = sessionController.generation
    error.value = ''
    try {
      await action()
    } catch (cause) {
      if (!abort.signal.aborted && identity === sessionController.generation)
        error.value = errorMessage(cause)
    }
  }
  async function reload(): Promise<void> {
    const generation = ++listingGeneration
    const identity = sessionController.generation
    const [connectors, projectList, sessionList, agentList] = await Promise.all(
      [
        auth.can('devices.read')
          ? conversationApi.devices(abort.signal)
          : Promise.resolve({ connectors: [] }),
        auth.can('projects.read')
          ? conversationApi.projects(abort.signal)
          : Promise.resolve({ projects: [] }),
        auth.can('sessions.read')
          ? conversationApi.sessions(
              {
                q: search.value || undefined,
                archived: String(archived.value),
              },
              abort.signal,
            )
          : Promise.resolve({ sessions: [], nextCursor: null }),
        auth.can('sessions.run')
          ? conversationApi.agents(abort.signal)
          : Promise.resolve({ items: [] }),
      ],
    )
    if (
      generation !== listingGeneration ||
      identity !== sessionController.generation ||
      abort.signal.aborted
    )
      return
    devices.value = connectors.connectors
    projects.value = projectList.projects
    sessions.value = sessionList.sessions
    nextCursor.value = sessionList.nextCursor
    agents.value = agentList.items
    if (!draft.value.deviceId)
      draft.value.deviceId =
        devices.value.find((device) => device.executorKind === 'server-agent')
          ?.id ??
        devices.value[0]?.id ??
        ''
    chooseProject()
  }
  /** 切换设备后不沿用另一个设备的项目；只有受管项目可以由 prepare 自动选中。 */
  function chooseProject(): void {
    if (selected.value) return
    if (!draft.value.deviceId && runtime.agent?.connectorId)
      draft.value.deviceId = runtime.agent.connectorId
    const connectorId = draft.value.deviceId
    const target = newSessionTarget(
      connectorId,
      project.value,
      projects.value,
      runtime.agent,
    )
    if (target) {
      project.value = target.projectId
      return
    }
    project.value =
      runtime.agent?.connectorId === connectorId
        ? (runtime.agent.projectId ?? '')
        : ''
  }
  async function moreSessions(): Promise<void> {
    const cursor = nextCursor.value,
      generation = listingGeneration
    if (!cursor) return
    await run(async () => {
      const result = await conversationApi.sessions(
        {
          q: search.value || undefined,
          archived: String(archived.value),
          cursor,
        },
        abort.signal,
      )
      if (generation !== listingGeneration || cursor !== nextCursor.value)
        return
      sessions.value = [
        ...new Map(
          [...sessions.value, ...result.sessions].map((item) => [
            item.id,
            item,
          ]),
        ).values(),
      ]
      nextCursor.value = result.nextCursor
    })
  }
  async function refreshSnapshot(): Promise<void> {
    const id = selected.value,
      request = ++snapshotRequest,
      generation = selectionGeneration,
      identity = sessionController.generation
    if (!id) return
    const value = await conversationApi.snapshot(id, abort.signal)
    if (
      id === selected.value &&
      request === snapshotRequest &&
      generation === selectionGeneration &&
      identity === sessionController.generation &&
      !abort.signal.aborted
    )
      snapshot.value = mergeSessionSnapshot(snapshot.value, value)
  }
  async function select(id: string, initial?: SessionSnapshot): Promise<void> {
    if (id === selected.value && snapshot.value) {
      await run(refreshSnapshot)
      return
    }
    stream.disconnect()
    selectionGeneration++
    selected.value = id
    snapshot.value = initial ?? null
    if (route.path !== `/workspace/session/${encodeURIComponent(id)}`)
      await router.replace(`/workspace/session/${encodeURIComponent(id)}`)
    await run(async () => {
      if (!initial) await refreshSnapshot()
      if (selected.value !== id || abort.signal.aborted) return
      await stream.connect()
      await conversationApi.update(id, { read: true })
      await loadCatalogs()
    })
  }
  function fresh(navigate = true): void {
    if (navigate) void router.replace('/workspace')
    stream.disconnect()
    selectionGeneration++
    selected.value = ''
    snapshot.value = null
    draftKey.value = 'new-session'
    agentId.value = ''
    shareUrl.value = ''
    if (!draft.value.deviceId) draft.value.deviceId = devices.value[0]?.id ?? ''
    chooseProject()
  }
  async function loadCatalogs(): Promise<void> {
    const generation = ++catalogGeneration,
      identity = sessionController.generation
    const connector =
      snapshot.value?.session.connectorId ?? draft.value.deviceId
    if (
      !connector ||
      devices.value.find((item) => item.id === connector)?.status !== 'online'
    ) {
      models.value = {}
      permissions.value = {}
      return
    }
    const id = selected.value
    const [model, access] = await Promise.all([
      conversationApi.catalog(
        connector,
        snapshot.value?.session.runtimeId ?? 'dsh',
        'model',
      ),
      conversationApi.catalog(
        connector,
        snapshot.value?.session.runtimeId ?? 'dsh',
        'permission',
      ),
    ])
    if (
      generation === catalogGeneration &&
      identity === sessionController.generation &&
      selected.value === id &&
      !abort.signal.aborted
    ) {
      models.value = model.catalog ?? model
      permissions.value = access.catalog ?? access
    }
  }
  async function prepare(): Promise<void> {
    await runtimeReadiness.prepare(true)
    await reload()
    if (!selected.value && runtime.agent?.connectorId) {
      draft.value.deviceId = runtime.agent.connectorId
      project.value = runtime.agent.projectId ?? ''
    }
  }
  async function send(): Promise<void> {
    if (
      sending.value ||
      !canComposeSession(snapshot.value?.session) ||
      (!draft.value.text.trim() && !draft.value.files.length)
    )
      return
    if (runtimeSelections.modelUnavailable.value) {
      error.value = '所选模型已不可用，请在下方重新选择后发送。'
      return
    }
    const target = selected.value
      ? null
      : newSessionTarget(
          draft.value.deviceId,
          project.value,
          projects.value,
          runtime.agent,
        )
    if (!selected.value && !target) {
      error.value = '请先在设备下选择有效项目；尚无项目时请先创建项目。'
      return
    }
    sending.value = true
    const current = draft.value,
      text = current.text,
      files = [...current.files],
      id = selected.value,
      identity = sessionController.generation
    // 新会话确认前保留用户正在看的配置；稍后的引擎快照仍是最终权威来源。
    const displayedModel =
      current.modelId ||
      selectionIdForModelCatalog(
        models.value,
        runtimeSelections.modelId.value,
        runtimeSelections.reasoningId.value,
      ) ||
      ''
    const displayedPermission =
      permission.value ||
      selectionIdForPermissionCatalog(
        permissions.value,
        runtimeSelections.permissionId.value,
      ) ||
      ''
    const signature = JSON.stringify([
      selected.value,
      current.deviceId,
      target?.projectId,
      agentId.value,
      current.modelId,
      permission.value,
      text,
      current.files.map((file) => [file.name, file.size, file.lastModified]),
    ])
    if (current.submission?.signature !== signature)
      current.submission = {
        id: createUuid(),
        signature,
        attachments: [],
      }
    const submission = current.submission
    pending.value = {
      sessionId: id,
      item: {
        id: `pending:${submission.id}`,
        type: 'message',
        role: 'user',
        pending: true,
        content: {
          text,
          attachments: files.map((file) => ({ name: file.name })),
        },
      },
    }
    await run(async () => {
      const attachments = submission.attachments
      const currentIdentity = () =>
        identity === sessionController.generation && !abort.signal.aborted
      for (const file of files.slice(attachments.length)) {
        if (!currentIdentity()) return
        const uploaded = await uploadFile(file, abort.signal, (value) => {
          if (currentIdentity()) uploadProgress.value = value
        })
        // 上传器可能在取消后仍返回结果，代际失效时不能写旧草稿或以新身份提交旧任务。
        if (!currentIdentity()) return
        attachments.push(uploaded)
      }
      if (!currentIdentity()) return
      const selections = {
        ...(current.modelId ? { model: current.modelId } : {}),
        ...(permission.value ? { permission: permission.value } : {}),
      }
      let createdId = id
      if (id)
        await conversationApi.send(id, {
          text,
          clientMessageId: submission.id,
          attachments,
          selections,
        })
      else {
        const created = await conversationApi.create({
          ...target!,
          ...(agentId.value ? { agentDefinitionId: agentId.value } : {}),
          runtimeId: 'dsh',
          runtime: 'dsh',
          clientMessageId: submission.id,
          text,
          attachments,
          selections,
        })
        createdId = created.session.id
      }
      if (identity !== sessionController.generation) return
      if (current.text === text) current.text = ''
      current.files = current.files.filter((file) => !files.includes(file))
      if (current.submission?.id === submission.id)
        current.submission = undefined
      // 接受后即使页面已离开也结算当前账号草稿；重新进入不会生成新的操作 ID 重发。
      if (abort.signal.aborted) return
      await reload()
      if (selected.value === id) {
        if (id) {
          // 继续同一会话只合并快照，不能断开订阅并清空状态，导致输入栏和消息闪回。
          await refreshSnapshot()
        } else {
          const initial = await conversationApi.snapshot(
            createdId,
            abort.signal,
          )
          if (!currentIdentity() || selected.value !== id) return
          Object.assign(drafts.draft(createdId), {
            deviceId: current.deviceId,
            modelId: displayedModel,
            permissionId: displayedPermission,
          })
          await select(createdId, initial)
        }
      }
    })
    sending.value = false
    pending.value = null
    uploadProgress.value = 0
  }
  // 侧栏中的同一记录可能同时出现在多个分组，所有入口共享提交锁。
  const editingSession = ref(false)
  async function updateSession(
    row: WorkspaceSession,
    action: SessionAction,
  ): Promise<void> {
    if (editingSession.value || !auth.can('sessions.run')) return
    const identity = sessionController.generation
    editingSession.value = true
    try {
      if (action === 'delete') return await lifecycle.remove(row)
      await run(async () => {
        const changes =
          action === 'rename'
            ? {
                title: (
                  await ElMessageBox.prompt('输入会话标题', '重命名', {
                    inputValue: row.title,
                  })
                ).value,
              }
            : action === 'pin'
              ? { pinned: !row.pinned }
              : { archived: !row.archived }
        // 重命名对话框等待输入期间，账号和写权限都可能发生变化。
        if (
          identity !== sessionController.generation ||
          abort.signal.aborted ||
          !auth.can('sessions.run')
        )
          return
        await conversationApi.update(row.id, changes)
        if (identity !== sessionController.generation || abort.signal.aborted)
          return
        if (selected.value === row.id) await refreshSnapshot()
        await reload()
      })
    } finally {
      editingSession.value = false
    }
  }
  async function older(): Promise<void> {
    // nextSeq 是事件恢复位置，历史翻页必须使用已显示首条消息的稳定顺序。
    const before = snapshot.value?.timeline.items[0]?.orderSeq,
      id = selected.value
    if (before === undefined || !snapshot.value?.timeline.hasMore) return
    await run(async () => {
      const page = await conversationApi.timeline(id, before, abort.signal)
      if (id !== selected.value || !snapshot.value) return
      snapshot.value.timeline = {
        ...page,
        items: mergeTimeline(page.items, snapshot.value.timeline.items),
      }
    })
  }
  async function respond(
    noticeId: string,
    response: Record<string, unknown>,
  ): Promise<void> {
    if (responding.value || !canControlSession(snapshot.value?.session)) return
    responding.value = true
    const id = selected.value
    try {
      await run(async () => {
        await conversationApi.respond(id, noticeId, response)
        if (selected.value === id) await refreshSnapshot()
      })
    } finally {
      responding.value = false
    }
  }
  async function toggleTakeover(): Promise<void> {
    const session = snapshot.value?.session
    if (!session || session.archived || takingOver.value) return
    const id = session.id,
      identity = sessionController.generation
    const enabled = !session.takeover
    takingOver.value = true
    try {
      await ElMessageBox.confirm(
        enabled
          ? '接管后可以发送消息和控制任务，是否继续？'
          : '取消接管后此会话将变为只读，是否继续？',
        enabled ? '接管会话' : '取消接管',
        { confirmButtonText: '确认', cancelButtonText: '取消' },
      )
      // 等待确认期间可能切换账号或会话，不能把确认应用到新的上下文。
      if (
        identity !== sessionController.generation ||
        selected.value !== id ||
        abort.signal.aborted
      )
        return
      await run(async () => {
        await conversationApi.takeover(id, enabled)
        if (
          identity !== sessionController.generation ||
          selected.value !== id ||
          abort.signal.aborted
        )
          return
        await refreshSnapshot()
        await reload()
      })
    } catch (cause) {
      if (cause !== 'cancel' && cause !== 'close' && !abort.signal.aborted)
        error.value = errorMessage(cause)
    } finally {
      takingOver.value = false
    }
  }
  async function sync(): Promise<void> {
    await run(async () => {
      await conversationApi.sync(selected.value)
      await refreshSnapshot()
    })
  }
  async function share(): Promise<void> {
    await run(async () => {
      shareUrl.value = new URL(
        (await conversationApi.share(selected.value)).share.url,
        location.origin,
      ).toString()
    })
  }
  watch([project, archived], () => {
    const active = projects.value.find((item) => item.id === project.value)
    if (active && !selected.value) draft.value.deviceId = active.connectorId
    void run(reload)
  })
  watch(
    () => route.path,
    (path) => {
      const session = /^\/workspace\/session\/([^/]+)$/.exec(path)?.[1]
      if (session && decodeURIComponent(session) !== selected.value)
        void select(decodeURIComponent(session))
      else if (!session && selected.value) fresh(false)
      archived.value = path === '/workspace/archived'
    },
  )
  const unsubscribe = sessionController.subscribe(() => {
    // 同账号刷新令牌、刷新权限不构成换号，不能抹去当前任务和历史。
    if (accountGeneration === sessionController.generation) return
    accountGeneration = sessionController.generation
    selectionGeneration++
    listingGeneration++
    catalogGeneration++
    selected.value = ''
    snapshot.value = null
    pending.value = null
    devices.value = []
    projects.value = []
    sessions.value = []
    agents.value = []
    models.value = {}
    permissions.value = {}
    shareUrl.value = ''
  })
  watch(
    () => draft.value.deviceId,
    () => {
      chooseProject()
      void run(loadCatalogs)
    },
  )
  onMounted(() => {
    void run(async () => {
      busy.value = true
      try {
        archived.value = route.path === '/workspace/archived'
        const trial = consumeAgentTrial()
        if (trial) {
          draftKey.value = `agent-trial:${createUuid()}`
          agentId.value = trial.agentId
          draft.value.text = trial.prompt
        }
        // 列表请求失败不能中断已开始的 Agent 状态同步。
        await Promise.all([
          reload(),
          auth.can('sessions.run')
            ? runtimeReadiness.prepare()
            : Promise.resolve(),
        ])
        const session = /^\/workspace\/session\/([^/]+)$/.exec(route.path)?.[1]
        if (session) await select(decodeURIComponent(session))
      } finally {
        busy.value = false
      }
    })
  })
  onScopeDispose(() => {
    abort.abort()
    unsubscribe()
  })
  return {
    interrupting: lifecycle.interrupting,
    runtimeReadiness,
    refreshSnapshot,
    takingOver,
    toggleTakeover,
    runtime,
    selected,
    snapshot,
    timeline,
    devices,
    projects,
    agents,
    nextCursor,
    sessions,
    project,
    search,
    archived,
    draft,
    agentId,
    busy,
    sending,
    responding,
    error,
    uploadProgress,
    shareUrl,
    models,
    permissions,
    permission,
    runtimeSelections,
    streamStatus: stream.status,
    reload: () => run(reload),
    select,
    fresh,
    prepare: () => run(prepare),
    send,
    editingSession,
    updateSession,
    older,
    respond,
    interrupt: lifecycle.interrupt,
    sync,
    share,
    moreSessions,
  }
}
