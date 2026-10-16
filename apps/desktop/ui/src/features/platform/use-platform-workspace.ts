import { useCallback, useEffect, useRef, useState } from 'react'
import {
  platformBridge,
  platformAgentCreation,
  platformAgentBinding,
  type PlatformAccountState,
  type PlatformJson,
  type PlatformRequest,
} from '@superdsh/core/client/platform'
import { object, rows, string, type Row } from './platform-model.ts'
import { useNewSessionOptions } from './use-new-session-options.ts'
import { useAgentDefinitions } from './use-agent-definitions.ts'
import { useAgentArtifacts } from './use-agent-artifacts.ts'
import {
  createPlatformConversationSource,
  type ConversationTarget,
} from '@superdsh/core/client/conversation'
import {
  ownedDeviceDirectory,
  type PlatformDevice,
} from './device-directory.ts'
export function usePlatformWorkspace() {
  const bridge = platformBridge()
  const [open, setOpen] = useState(false)
  const [account, setAccount] = useState<PlatformAccountState | null>(null)
  const [origin, setOrigin] = useState('')
  const [deviceDirectory, setDeviceDirectory] = useState<{
    identity: string
    loaded: boolean
    devices: PlatformDevice[]
    error: string | null
  }>({ identity: '', loaded: false, devices: [], error: null })
  const directoryIdentity = account?.identityKey
    ? JSON.stringify([account.identityKey, account.identityGeneration])
    : ''
  const devices =
    deviceDirectory.identity === directoryIdentity
      ? deviceDirectory.devices
      : []
  const devicesLoaded =
    !!directoryIdentity &&
    deviceDirectory.identity === directoryIdentity &&
    deviceDirectory.loaded
  const deviceError =
    deviceDirectory.identity === directoryIdentity
      ? deviceDirectory.error
      : null
  const [device, setDevice] = useState('')
  const [sessions, setSessions] = useState<Row[]>([])
  const [sessionCursor, setSessionCursor] = useState('')
  const [olderItems, setOlderItems] = useState<Row[]>([])
  const [hasOlder, setHasOlder] = useState(false)
  const [sessionId, setSessionId] = useState('')
  const [nativeSessionId, setNativeSessionId] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<Row>({})
  const [models, setModels] = useState<Row[]>([])
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<PlatformJson[]>([])
  const [workspaceInput, setWorkspace] = useState('')
  const [serverWorkspace, setServerWorkspace] = useState<{
    identity: string
    connectorId: string
    projectId: string
    path: string
  } | null>(null)
  const [tab, setTab] = useState<'chat' | 'files' | 'terminal'>('chat')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [serverAgent, setServerAgent] = useState<Row>({})
  const [serverAgentError, setServerAgentError] = useState('')
  const [awaitingServerAgent, setAwaitingServerAgent] = useState(false)
  const generation = useRef(0)
  const snapshotSequence = useRef(0)
  const deviceRefreshSequence = useRef(0)
  const serverAgentSequence = useRef(0)
  const serverAgentPreparing = useRef(false)
  const deviceIntent = useRef(0)
  const watchOwner = useRef('')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const accountRef = useRef(account)
  accountRef.current = account
  const selectionRef = useRef({ device, sessionId })
  selectionRef.current = { device, sessionId }
  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener('superdsh:platform-open', show)
    return () => window.removeEventListener('superdsh:platform-open', show)
  }, [])
  useEffect(() => {
    if (!bridge) return
    let disposed = false
    const refresh = () => {
      void bridge
        .state()
        .then((value) => {
          if (!disposed)
            setAccount((current) =>
              (current?.identityGeneration ?? 0) >
              (value.identityGeneration ?? 0)
                ? current
                : value,
            )
        })
        .catch((reason) => {
          if (!disposed) setError(String(reason))
        })
    }
    refresh()
    const interval = setInterval(refresh, 2000)
    return () => {
      disposed = true
      clearInterval(interval)
    }
  }, [bridge])
  useEffect(() => {
    generation.current++
    setBusy(false)
    setDevice('')
    setSessionId('')
    setDeviceDirectory({
      identity: '',
      loaded: false,
      devices: [],
      error: null,
    })
    deviceRefreshSequence.current++
    setSessions([])
    setSnapshot({})
    setDraft('')
    setAttachments([])
    setWorkspace('')
    setServerWorkspace(null)
    setError('')
    setServerAgent({})
    setServerAgentError('')
    setAwaitingServerAgent(false)
    serverAgentSequence.current++
    deviceIntent.current++
    serverAgentPreparing.current = false
  }, [account?.identityGeneration])
  const run = async (action: () => Promise<void>) => {
    const current = generation.current
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (reason) {
      if (current === generation.current)
        setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (current === generation.current) setBusy(false)
    }
  }
  const request = useCallback(
    async (value: PlatformRequest) => {
      if (!bridge) throw new Error('桌面平台服务不可用')
      const identity =
        account?.identityKey && account.identityGeneration !== undefined
          ? { key: account.identityKey, generation: account.identityGeneration }
          : undefined
      if (
        !identity ||
        identity.key !== accountRef.current?.identityKey ||
        identity.generation !== accountRef.current?.identityGeneration
      )
        throw new Error('账号已切换，请重新选择目标')
      const result = await bridge.request({ ...value, identity })
      if (
        identity.key !== accountRef.current?.identityKey ||
        identity.generation !== accountRef.current?.identityGeneration
      )
        throw new Error('账号已切换，此响应已丢弃')
      return result
    },
    [bridge, account?.identityKey, account?.identityGeneration],
  )
  const refreshDevices = useCallback(async () => {
    const sequence = ++deviceRefreshSequence.current
    try {
      const value = object(await request({ operation: 'devices' }))
      if (sequence !== deviceRefreshSequence.current) return
      setDeviceDirectory({
        identity: directoryIdentity,
        loaded: true,
        devices: ownedDeviceDirectory(value.connectors, account?.user?.userId),
        error: null,
      })
    } catch (reason) {
      if (sequence === deviceRefreshSequence.current)
        setDeviceDirectory((current) => ({
          identity: directoryIdentity,
          loaded: true,
          devices:
            current.identity === directoryIdentity ? current.devices : [],
          error: '无法刷新平台设备，连接状态暂不可确认。',
        }))
      throw reason
    }
  }, [request, account?.user?.userId, directoryIdentity])
  const selectDevice = (next: string) => {
    if (
      next &&
      (next === account?.connectorId || !devices.some((row) => row.id === next))
    )
      return
    deviceIntent.current++
    setAwaitingServerAgent(false)
    setDevice(next)
  }
  useEffect(() => {
    if (account?.status !== 'ready' || account.user?.resetRequired) return
    let disposed = false
    let loading = false
    const refresh = async () => {
      if (loading || serverAgentPreparing.current) return
      loading = true
      const sequence = ++serverAgentSequence.current
      try {
        const result = object(await request({ operation: 'server-agent' }))
        if (!disposed && sequence === serverAgentSequence.current) {
          const agent = object(result.agent)
          setServerAgent(agent)
          if (agent.status === 'starting' || agent.status === 'running')
            setServerAgentError('')
        }
      } catch (reason) {
        if (!disposed && sequence === serverAgentSequence.current)
          setServerAgentError(
            reason instanceof Error ? reason.message : String(reason),
          )
      } finally {
        loading = false
      }
    }
    void refresh()
    const interval = setInterval(() => void refresh(), 3000)
    return () => {
      disposed = true
      clearInterval(interval)
    }
  }, [account?.status, account?.user?.resetRequired, request])
  useEffect(() => {
    if (!awaitingServerAgent || serverAgent.status !== 'running') return
    const id = string(serverAgent.connectorId)
    if (!string(serverAgent.runtimeId) || !string(serverAgent.projectId)) return
    if (
      !devices.some(
        (row) => row.id === id && row.status === 'online' && !row.blockedAt,
      )
    )
      return
    setDevice(id)
    setAwaitingServerAgent(false)
    window.dispatchEvent(new Event('superdsh:conversation-target'))
  }, [awaitingServerAgent, serverAgent, devices])
  const prepareServerAgent = async () => {
    setServerAgentError('')
    setAwaitingServerAgent(false)
    const intent = ++deviceIntent.current
    const sequence = ++serverAgentSequence.current
    serverAgentPreparing.current = true
    try {
      const result = object(
        await request({ operation: 'prepare-server-agent' }),
      )
      if (sequence !== serverAgentSequence.current) return
      setServerAgent(object(result.agent))
      if (intent === deviceIntent.current) setAwaitingServerAgent(true)
      newSession.refresh()
      await refreshDevices()
    } catch (reason) {
      if (sequence === serverAgentSequence.current)
        setServerAgentError(
          reason instanceof Error ? reason.message : String(reason),
        )
      throw reason
    } finally {
      if (sequence === serverAgentSequence.current)
        serverAgentPreparing.current = false
    }
  }
  useEffect(() => {
    if (
      device &&
      (device === account?.connectorId ||
        (devicesLoaded && !devices.some((row) => row.id === device)))
    )
      setDevice('')
  }, [device, account?.connectorId, devices, devicesLoaded])
  const refreshSessions = useCallback(async () => {
    if (!device) return
    const current = generation.current
    const value = object(
      await request({ operation: 'sessions', query: { limit: '100' } }),
    )
    if (current !== generation.current) return
    setSessions(
      rows(value.sessions).filter((row) => row.connectorId === device),
    )
    setSessionCursor(string(value.nextCursor))
  }, [device, request])
  const selected = devices.find((row) => row.id === device)
  const isServerAgent = selected?.executorKind === 'server-agent'
  const agents = useAgentDefinitions(request, device, sessionId, isServerAgent)
  const artifacts = useAgentArtifacts(
    request,
    device,
    sessionId,
    isServerAgent,
    string(object(snapshot.state).status) === 'idle'
      ? `idle:${string(snapshot.eventCursor)}`
      : string(object(snapshot.state).status),
  )
  const newSession = useNewSessionOptions(
    request,
    device,
    sessionId,
    !!device,
    isServerAgent
      ? serverAgent.connectorId === device
        ? string(serverAgent.runtimeId)
        : ''
      : undefined,
  )
  useEffect(() => {
    if (account?.status !== 'ready' || account.user?.resetRequired) return
    let disposed = false
    const refresh = () => {
      void refreshDevices().catch((reason) => {
        if (!disposed) setError(String(reason))
      })
    }
    refresh()
    const interval = setInterval(refresh, 5000)
    return () => {
      disposed = true
      clearInterval(interval)
    }
  }, [account?.status, account?.user?.resetRequired, refreshDevices])
  useEffect(() => {
    generation.current++
    setBusy(false)
    setSessionId('')
    setSessionCursor('')
    setSnapshot({})
    setDraft('')
    setAttachments([])
    setWorkspace('')
    if (!device) {
      setSessions([])
      return
    }
    let disposed = false
    void request({ operation: 'sessions', query: { limit: '100' } })
      .then((value) => {
        if (!disposed) {
          setSessions(
            rows(object(value).sessions).filter(
              (row) => row.connectorId === device,
            ),
          )
          setSessionCursor(string(object(value).nextCursor))
        }
      })
      .catch((reason) => {
        if (!disposed) setError(String(reason))
      })
    return () => {
      disposed = true
    }
  }, [device, request])
  const refreshSession = useCallback(async () => {
    if (
      !sessionId ||
      selectionRef.current.device !== device ||
      selectionRef.current.sessionId !== sessionId
    )
      return
    const current = generation.current
    const sequence = ++snapshotSequence.current
    const value = object(
      await request({
        operation: 'snapshot',
        sessionId,
        query: { limit: '200' },
      }),
    )
    if (current !== generation.current || sequence !== snapshotSequence.current)
      return
    setSnapshot(value)
    setModels(rows(object(object(value.catalogs).model).models))
    const cwd = string(object(value.session).cwd)
    if (cwd) setWorkspace(cwd)
  }, [request, device, sessionId])
  useEffect(() => {
    generation.current++
    setBusy(false)
    setSnapshot({})
    setOlderItems([])
    setHasOlder(false)
    setDraft('')
    setAttachments([])
    setModels([])
    if (!device || !sessionId || !bridge) return
    const owner = crypto.randomUUID()
    watchOwner.current = owner
    const reportError = (reason: unknown) => {
      if (owner === watchOwner.current) setError(String(reason))
    }
    void refreshSession().catch(reportError)
    void request({ operation: 'models', sessionId })
      .then((value) => {
        if (owner === watchOwner.current)
          setModels(rows(object(object(value).catalog).models))
      })
      .catch(() => {})
    const unsubscribe = bridge.subscribe((event) => {
      if (event.sessionId !== sessionId) return
      if (
        event.identity?.key !== account?.identityKey ||
        event.identity?.generation !== account?.identityGeneration
      )
        return
      // A bounded refresh folds authoritative snapshots, including reconnect gaps.
      if (!timer.current)
        timer.current = setTimeout(() => {
          timer.current = undefined
          void refreshSession().catch(reportError)
        }, 80)
    })
    void bridge
      .watch(
        sessionId,
        owner,
        account?.identityKey && account.identityGeneration !== undefined
          ? { key: account.identityKey, generation: account.identityGeneration }
          : undefined,
      )
      .catch(reportError)
    return () => {
      generation.current++
      if (watchOwner.current === owner) watchOwner.current = ''
      clearTimeout(timer.current)
      timer.current = undefined
      unsubscribe()
      void bridge.stopWatch(owner)
    }
  }, [
    device,
    sessionId,
    bridge,
    request,
    refreshSession,
    account?.identityKey,
    account?.identityGeneration,
  ])
  const serverConnectorId = string(serverAgent.connectorId)
  const serverProjectId = string(serverAgent.projectId)
  const workspace = isServerAgent
    ? serverWorkspace?.identity === directoryIdentity &&
      serverWorkspace.connectorId === device &&
      serverWorkspace.projectId === serverProjectId &&
      device === serverConnectorId
      ? serverWorkspace.path
      : ''
    : workspaceInput
  useEffect(() => {
    setServerWorkspace(null)
    if (!isServerAgent || device !== serverConnectorId || !serverProjectId)
      return
    let disposed = false
    void request({ operation: 'projects' })
      .then((value) => {
        if (disposed || selectionRef.current.device !== device) return
        const project = rows(object(value).projects).find(
          (row) => row.id === serverProjectId && row.connectorId === device,
        )
        const path = string(project?.workspacePath)
        if (!path) throw new Error('服务端工作区尚未准备完成，请重试')
        setServerWorkspace({
          identity: directoryIdentity,
          connectorId: device,
          projectId: serverProjectId,
          path,
        })
      })
      .catch((reason) => {
        if (!disposed && selectionRef.current.device === device)
          setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      disposed = true
    }
  }, [
    device,
    isServerAgent,
    serverConnectorId,
    serverProjectId,
    serverAgent.status,
    directoryIdentity,
    request,
  ])
  const online = selected?.status === 'online' && !selected.blockedAt
  const capabilities = rows(object(snapshot.effectiveCapabilities).capabilities)
  const allows = (name: string) =>
    capabilities.some(
      (row) =>
        row.capabilityId === name &&
        row.supported === true &&
        row.available === true &&
        row.allowed === true,
    )
  const items = [
    ...new Map(
      [...olderItems, ...rows(object(snapshot.timeline).items)].map((item) => [
        string(item.id),
        item,
      ]),
    ).values(),
  ].sort((left, right) => Number(left.orderSeq) - Number(right.orderSeq))
  const notices = rows(snapshot.notices).filter(
    (row) =>
      row.responseRequired === true &&
      !['resolved', 'closed', 'expired', 'cancelled'].includes(
        string(row.status),
      ),
  )
  const target: ConversationTarget =
    device && account?.user && account.origin && account.identityKey
      ? {
          kind: 'platform',
          identityKey: account.identityKey,
          identityGeneration: account.identityGeneration ?? 0,
          origin: account.origin,
          userId: account.user.userId,
          connectorId: device,
          executorKind: selected?.executorKind ?? 'desktop',
          runtimeId:
            string(object(snapshot.session).runtimeId) ||
            newSession.runtimeId ||
            null,
          sessionId: sessionId || null,
          externalSessionId:
            string(object(snapshot.session).externalSessionId) || null,
        }
      : { kind: 'native', sessionId: nativeSessionId }
  const source =
    bridge && target.kind === 'platform'
      ? createPlatformConversationSource(bridge, target, () => ({
          identityKey: accountRef.current?.identityKey ?? null,
          identityGeneration: accountRef.current?.identityGeneration ?? 0,
        }))
      : null
  const send = async () => {
    if (!draft.trim() && attachments.length === 0) return
    const current = generation.current
    const clientMessageId = crypto.randomUUID()
    if (sessionId) {
      if (!source) throw new Error('请选择目标会话')
      await source.send(draft, clientMessageId, attachments)
      if (current !== generation.current) return
      setDraft('')
      setAttachments([])
      await refreshSession()
    } else {
      const agentSelection = platformAgentCreation(
        isServerAgent ? 'server-agent' : 'desktop',
        sessionId,
        agents.selectedId,
        agents.items,
      )
      if (!workspace.trim())
        throw new Error(
          isServerAgent
            ? '服务端工作区尚未准备完成，请重试'
            : '请输入目标设备的工作区绝对路径',
        )
      if (!newSession.runtimeId || !newSession.model || !newSession.permission)
        throw new Error('请先选择新会话的模型和权限')
      const projects = rows(
        object(await request({ operation: 'projects' })).projects,
      )
      if (current !== generation.current) return
      let project = projects.find(
        (row) =>
          row.connectorId === device &&
          row.workspacePath === workspace &&
          (!isServerAgent || row.id === serverAgent.projectId),
      )
      if (isServerAgent && !project)
        throw new Error('服务端工作区尚未准备完成，请重试')
      const baseName =
        workspace.split(/[\\/]/).filter(Boolean).at(-1) || 'Workspace'
      let projectName = baseName
      for (
        let suffix = 2;
        projects.some((row) => row.name === projectName);
        suffix++
      )
        projectName = `${baseName} (${suffix})`
      project ??= object(
        object(
          await request({
            operation: 'create-project',
            body: {
              name: projectName,
              connectorId: device,
              workspacePath: workspace,
              manuallyCreated: true,
            },
          }),
        ).project,
      )
      if (current !== generation.current) return
      const value = object(
        await request({
          operation: 'create-session',
          body: {
            ...agentSelection,
            connectorId: device,
            projectId: string(project.id),
            runtime: 'dsh',
            runtimeId: newSession.runtimeId,
            selections: {
              model: newSession.model,
              permission: newSession.permission,
            },
            cwd: workspace,
            content: draft,
            clientMessageId,
          },
        }),
      )
      const created = object(value.session)
      if (current !== generation.current) return
      setSessions((previous) => [created, ...previous])
      setSessionId(string(created.id))
      setDraft('')
    }
  }
  const loadMoreSessions = async () => {
    const current = generation.current
    const value = object(
      await request({
        operation: 'sessions',
        query: { limit: '100', cursor: sessionCursor },
      }),
    )
    if (current !== generation.current) return
    setSessions((previous) => [
      ...previous,
      ...rows(value.sessions).filter((row) => row.connectorId === device),
    ])
    setSessionCursor(string(value.nextCursor))
  }
  const loadOlder = async (before: number) => {
    const current = generation.current
    if (!source) return
    const value = object(await source.history(before))
    if (current !== generation.current) return
    setOlderItems((previous) => [...rows(value.items), ...previous])
    setHasOlder(value.hasMore === true)
  }
  const upload = async (
    files: { name: string; type: string; data: Uint8Array }[],
  ) => {
    if (!bridge || !sessionId) throw new Error('请先选择会话')
    if (
      selectionRef.current.device !== device ||
      selectionRef.current.sessionId !== sessionId
    )
      throw new Error('目标已切换，请重新选择附件')
    const identity =
      account?.identityKey && account.identityGeneration !== undefined
        ? { key: account.identityKey, generation: account.identityGeneration }
        : undefined
    if (
      !identity ||
      identity.key !== accountRef.current?.identityKey ||
      identity.generation !== accountRef.current?.identityGeneration
    )
      throw new Error('账号已切换，请重新选择附件')
    const current = generation.current
    const value = await bridge.upload(sessionId, files, identity)
    if (current !== generation.current)
      throw new Error('目标已切换，此附件响应已丢弃')
    return value
  }
  const downloadAttachment = async (fileId: string) => {
    if (
      !sessionId ||
      selectionRef.current.device !== device ||
      selectionRef.current.sessionId !== sessionId
    )
      throw new Error('请先选择文件所属会话')
    const current = generation.current
    const result = await request({
      operation: 'download-attachment',
      sessionId,
      attachmentId: fileId,
    })
    if (current !== generation.current)
      throw new Error('目标已切换，此文件响应已丢弃')
    return result
  }
  return {
    agents,
    artifacts,
    agentBinding:
      (object(snapshot.session).id === sessionId
        ? platformAgentBinding(object(snapshot.session).agentDefinition)
        : null) ?? artifacts.binding,
    downloadAttachment,
    serverAgent,
    serverAgentError,
    prepareServerAgent,
    isServerAgent,
    newSession,
    source,
    target,
    bridge,
    open,
    setOpen,
    account,
    origin,
    setOrigin,
    devices,
    devicesLoaded,
    deviceError,
    device,
    setDevice: selectDevice,
    sessions,
    setSessions,
    sessionCursor,
    setSessionCursor,
    olderItems,
    setOlderItems,
    hasOlder,
    setHasOlder,
    sessionId,
    setSessionId,
    setNativeSessionId,
    snapshot,
    models,
    draft,
    setDraft,
    attachments,
    setAttachments,
    workspace,
    setWorkspace,
    tab,
    setTab,
    busy,
    error,
    run,
    request,
    refreshDevices,
    refreshSessions,
    loadMoreSessions,
    loadOlder,
    refreshSession,
    selected,
    online,
    allows,
    items,
    notices,
    send,
    upload,
  }
}
export type PlatformWorkspaceModel = ReturnType<typeof usePlatformWorkspace>
