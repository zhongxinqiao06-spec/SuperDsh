/** 工作台使用持久会话身份，设备与引擎状态分别表达。 */
export type SessionAction = 'rename' | 'pin' | 'archive' | 'delete'

export interface WorkspaceConnector {
  id: string
  name: string
  executorKind: string
  status: 'online' | 'offline'
  deviceOs?: string | null
}

export interface WorkspaceProject {
  id: string
  connectorId: string
  name: string
  workspacePath: string
  pinned: boolean
  activeSessionCount: number
  manuallyCreated?: boolean
  sidebarSessionCounts?: { active: number; archived: number }
  lastActivityAt?: string | null
  createdAt?: string
  updatedAt?: string
}

export interface WorkspaceSession {
  id: string
  connectorId: string
  executorKind?: 'desktop' | 'server-agent'
  projectId: string | null
  runtimeId: string
  runtime: string
  title: string
  cwd: string
  status: string
  pinned: boolean
  archived: boolean
  takeover: boolean
  unread: boolean
  updatedSeq: number
  lastActivityAt?: string | null
  sortAt?: string | null
  connectorStatus?: 'online' | 'offline'
  agentDefinition: Record<string, unknown> | null
}

export interface TimelineItem {
  id: string
  type: string
  role?: string
  orderSeq?: number
  revision?: number
  content?: unknown
  source?: Record<string, unknown>
  [key: string]: unknown
}

export interface RuntimeNotice {
  id: string
  type?: string
  title?: string
  message?: string
  [key: string]: unknown
}

export interface SessionSnapshot {
  session: WorkspaceSession
  state: Record<string, unknown>
  timeline: { items: TimelineItem[]; nextSeq: number | null; hasMore: boolean }
  notices: RuntimeNotice[]
  approvals: RuntimeNotice[]
  effectiveCapabilities: Record<string, unknown>
  eventCursor: string
}

export interface SessionEvent {
  protocolVersion: string
  eventId: string
  sequence: number
  cursor: string
  type: string
  sessionId: string
  payload: Record<string, unknown>
}

export interface UploadedAttachment {
  fileId: string
  name: string
  mediaType: string
  size: number
  sha256: string
}

/** 目录身份用于展示，selectionId 才是引擎接受的不可猜测选择标识。 */
export interface RuntimeCatalogItem {
  id: string
  selectionId?: string | null
  displayName?: string
  name?: string
  label?: string
  description?: string | null
  enabled?: boolean
  disabledReason?: string | null
  default?: boolean
  metadata?: Record<string, unknown> | null
  reasoningItems?: RuntimeCatalogItem[]
}

export interface RuntimeCatalog {
  models?: RuntimeCatalogItem[]
  permissions?: RuntimeCatalogItem[]
  items?: RuntimeCatalogItem[]
  catalog?: RuntimeCatalog
}
