import { request } from '@/utils/request'
import type {
  RuntimeCatalog,
  SessionEvent,
  SessionSnapshot,
  WorkspaceConnector,
  WorkspaceProject,
  WorkspaceSession,
  UploadedAttachment,
} from '@/types/workbench/models'
import type { AgentList } from '@/types/agents/agents'

/** 工作台传输契约不包含 UI 状态或执行重试，副作用保留调用方稳定操作 ID。 */
export const conversationApi = {
  agents: (signal?: AbortSignal) =>
    request<AgentList>('/agents', { query: { pageSize: 100 }, signal }),
  devices: (signal?: AbortSignal) =>
    request<{ connectors: WorkspaceConnector[] }>('/connectors', { signal }),
  projects: (signal?: AbortSignal) =>
    request<{ projects: WorkspaceProject[] }>('/projects', { signal }),
  /** 全量清单用于明确的批量动作，正常侧栏仍按分页入口加载。 */
  inventory: (signal?: AbortSignal) =>
    request<{ sessions: WorkspaceSession[] }>('/sessions/list', { signal }),
  sessions: (query: Record<string, string | undefined>, signal?: AbortSignal) =>
    request<{ sessions: WorkspaceSession[]; nextCursor: string | null }>(
      '/sessions',
      { query, signal },
    ),
  create: (body: Record<string, unknown>) =>
    request<{ session: WorkspaceSession }>('/sessions/create-and-start', {
      method: 'POST',
      body,
    }),
  remove: (id: string) =>
    request<{ deleted: boolean }>(`/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  snapshot: (id: string, signal?: AbortSignal) =>
    request<SessionSnapshot>(`/sessions/${encodeURIComponent(id)}/snapshot`, {
      signal,
    }),
  events: (id: string, cursor: string, signal?: AbortSignal) =>
    request<{
      events: SessionEvent[]
      snapshotRequired: boolean
      nextCursor: string
    }>(`/sessions/${encodeURIComponent(id)}/events`, {
      query: { cursor },
      signal,
    }),
  timeline: (id: string, before: number, signal?: AbortSignal) =>
    request<SessionSnapshot['timeline']>(
      `/sessions/${encodeURIComponent(id)}/timeline`,
      { query: { mode: 'history', beforeOrderSeq: before }, signal },
    ),
  update: (
    id: string,
    body: Partial<Pick<WorkspaceSession, 'title' | 'pinned' | 'archived'>> & {
      read?: boolean
    },
  ) =>
    request<{ session: WorkspaceSession }>(
      `/sessions/${encodeURIComponent(id)}/meta`,
      { method: 'PATCH', body },
    ),
  send: (
    id: string,
    body: {
      text: string
      clientMessageId: string
      attachments: UploadedAttachment[]
      selections?: Record<string, unknown>
    },
  ) =>
    request(`/sessions/${encodeURIComponent(id)}/runtime/messages`, {
      method: 'POST',
      body,
    }),
  /** 接管接口沿用 DSH 控制语义，成功后由用例刷新会话真实状态。 */
  takeover: (id: string, enabled: boolean) =>
    request<{ session: WorkspaceSession }>(
      `/sessions/${encodeURIComponent(id)}/takeover`,
      { method: enabled ? 'POST' : 'DELETE' },
    ),
  interrupt: (id: string) =>
    request<{ accepted?: boolean; missing?: boolean }>(
      `/sessions/${encodeURIComponent(id)}/runtime/interrupt`,
      {
        method: 'POST',
      },
    ),
  sync: (id: string) =>
    request(`/sessions/${encodeURIComponent(id)}/sync`, { method: 'POST' }),
  respond: (id: string, notice: string, body: Record<string, unknown>) =>
    request(
      `/sessions/${encodeURIComponent(id)}/runtime/notices/${encodeURIComponent(notice)}/respond`,
      { method: 'POST', body },
    ),
  selections: (id: string, selections: Record<string, unknown>) =>
    request(`/sessions/${encodeURIComponent(id)}/runtime/selections`, {
      method: 'PATCH',
      body: { selections },
    }),
  catalog: (connector: string, runtime: string, kind: 'model' | 'permission') =>
    request<RuntimeCatalog>(
      `/connectors/${encodeURIComponent(connector)}/runtimes/${encodeURIComponent(runtime)}/catalogs/${kind}`,
    ),
  share: (id: string) =>
    request<{ share: { id: string; url: string } }>(
      `/sessions/${encodeURIComponent(id)}/shares`,
      { method: 'POST' },
    ),
  publicShare: (id: string) =>
    request<{
      session: Pick<WorkspaceSession, 'id' | 'title'>
      timeline: SessionSnapshot['timeline']
    }>(`/public/shares/${encodeURIComponent(id)}`, { auth: false }),
  ticket: (sessionId: string, clientId: string) =>
    request<{ ticket: string }>('/ws-ticket', {
      method: 'POST',
      body: { clientId, scope: { sessionId } },
    }),
}
