/** 设备目录与运行实例保留公开协议字段，所有权由后端核验。 */
export interface Device {
  id: string
  userId: string
  username?: string
  name: string
  connectorKind: string
  executorKind: string
  deviceOs: string | null
  status: string
  lastSeenAt: string | null
  blockedAt: string | null
  blockedReason: string | null
  version: string | null
}
export interface DeviceInventory {
  devices: Device[]
  total: number
  page: number
  pageSize: number
}
export interface RuntimeSchema {
  type?: string
  title?: string
  description?: string
  default?: unknown
  enum?: (string | number | boolean)[]
  properties?: Record<string, RuntimeSchema>
  required?: string[]
  items?: RuntimeSchema
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  format?: string
  additionalProperties?: boolean | RuntimeSchema
}
export interface RuntimeUi {
  [key: string]: unknown
}
export interface RuntimeType {
  runtimeType: string
  displayName: string
  description?: string | null
  schema?: RuntimeSchema | null
  uiSchema?: RuntimeUi
  defaults?: Record<string, unknown>
  available?: boolean
  reason?: string | null
  instancePolicy?: 'single' | 'multiple'
  maxInstances?: number | null
}
export interface DeviceRuntime extends RuntimeType {
  id: string
  runtimeId: string
  name: string
  config: Record<string, unknown> | null
  configured: boolean
  active: boolean
  managed?: boolean
  status: string
  revision?: number
  error?: Record<string, unknown> | null
}
export interface RuntimeDraft {
  name: string
  runtimeType: string
  config: Record<string, unknown>
  active: boolean
}
export interface DeviceDraft {
  name: string
  connectorKind: string
  executorKind: string
  deviceOs?: string
}
