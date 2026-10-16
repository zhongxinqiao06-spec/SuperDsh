import { useEffect, useState } from 'react'
import {
  object,
  rows,
  string,
  type Request,
  type Row,
} from './platform-model.ts'
import { remotePlatformDefault } from './remote-model-default.ts'
import { newSessionRuntime } from './new-session-runtime.ts'
export function useNewSessionOptions(
  request: Request,
  device: string,
  sessionId: string,
  open: boolean,
  managedRuntimeId?: string,
) {
  const [runtimeId, setRuntimeId] = useState('')
  const [models, setModels] = useState<Row[]>([])
  const [permissions, setPermissions] = useState<Row[]>([])
  const [model, setModel] = useState('')
  const [permission, setPermission] = useState('')
  const [error, setError] = useState('')
  const [version, setVersion] = useState(0)
  useEffect(() => {
    setRuntimeId('')
    setModels([])
    setPermissions([])
    setModel('')
    setPermission('')
    setError('')
    if (!device || sessionId || !open) return
    let disposed = false
    void (async () => {
      const runtime = newSessionRuntime(
        rows(
          object(await request({ operation: 'runtimes', connectorId: device }))
            .runtimes,
        ),
        managedRuntimeId,
      )
      if (!runtime) throw new Error('目标设备尚未启用 DSH 运行环境')
      const id = string(runtime.runtimeId) || string(runtime.id)
      const [modelResult, permissionResult, platform] = await Promise.all([
        request({
          operation: 'runtime-models',
          connectorId: device,
          runtimeId: id,
        }),
        request({
          operation: 'runtime-permissions',
          connectorId: device,
          runtimeId: id,
        }),
        request({ operation: 'model-catalog' }).then(
          (value) => ({ ok: true as const, value }),
          (reason: unknown) => ({ ok: false as const, reason }),
        ),
      ])
      if (disposed) return
      const availableModels = rows(
        object(object(modelResult).catalog).models,
      ).filter((row) => object(row.metadata).enabled !== false)
      const availablePermissions = rows(
        object(object(permissionResult).catalog).permissions,
      ).filter((row) => object(row.metadata).enabled !== false)
      const defaultValue = platform.ok
        ? object(platform.value).default
        : undefined
      const platformDefault = object(defaultValue)
      const preferred = !platform.ok
        ? undefined
        : defaultValue === null
          ? availableModels.find((row) => row.default === true)
          : remotePlatformDefault(availableModels, platformDefault)
      if (!platform.ok)
        setError(
          `平台模型目录不可用：${platform.reason instanceof Error ? platform.reason.message : String(platform.reason)}。请明确选择本次会话使用的模型。`,
        )
      else if (defaultValue !== null && !preferred)
        setError(
          '平台默认模型在目标设备上未找到唯一可用来源。请等待同步，或明确选择本次会话使用的模型。',
        )
      const permissionDefault =
        availablePermissions.find(
          (row) => object(row.metadata).preset === 'workspace-write',
        ) ??
        availablePermissions.find((row) => row.default === true) ??
        availablePermissions[0]
      setRuntimeId(id)
      setModels(availableModels)
      setPermissions(availablePermissions)
      setModel(string(preferred?.selectionId) || string(preferred?.id))
      setPermission(
        string(permissionDefault?.selectionId) || string(permissionDefault?.id),
      )
    })().catch((reason) => {
      if (!disposed)
        setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => {
      disposed = true
    }
  }, [device, sessionId, open, request, version, managedRuntimeId])
  return {
    refresh: () => setVersion((current) => current + 1),
    runtimeId,
    models,
    permissions,
    model,
    setModel,
    permission,
    setPermission,
    error,
  }
}
