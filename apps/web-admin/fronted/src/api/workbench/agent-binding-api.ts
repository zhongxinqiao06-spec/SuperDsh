import { request } from '@/utils/request'

/** 会话绑定是冻结快照，更新必须提交已读取的绑定版本，防止覆盖另一窗口。 */
export interface SessionAgentBinding {
  agentDefinition: { id: string; name: string; version?: number } | null
  bindingVersion: number
}
const path = (id: string) => `/sessions/${encodeURIComponent(id)}/agent-binding`
export const agentBindingApi = {
  get: (id: string, signal: AbortSignal) =>
    request<SessionAgentBinding>(path(id), { signal }),
  update: (id: string, agentDefinitionId: string, bindingVersion: number) =>
    request<SessionAgentBinding>(path(id), {
      method: 'PUT',
      body: { agentDefinitionId, bindingVersion },
    }),
}
