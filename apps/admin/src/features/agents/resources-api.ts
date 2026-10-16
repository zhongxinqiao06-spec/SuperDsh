import { apiClient } from '@/lib/api'
import { sessionIdentityRevision } from '@/features/auth/session'

export type AgentResource = {
  id: string
  name: string
  description: string
  enabled: boolean
  version: number
  createdAt: string
  updatedAt: string
}
export type KnowledgeBase = AgentResource & { assetIds: string[] }
export type AgentSkill = AgentResource & {
  instructions: string
  requiredToolIds: string[]
}
export type AgentTool = AgentResource & {
  settings: { companyName?: string; title?: string; maxResults?: number }
}
export type ResourceWrite<T extends AgentResource> = Omit<
  T,
  'id' | 'createdAt' | 'updatedAt' | 'version'
> & { version?: number }
export type ResourcePage<T> = {
  items: T[]
  total: number
  page: number
  pageSize: number
}

let initialization: { identity: number; promise: Promise<void> } | null = null

/** Initialize persisted examples once per login; a failed request is retryable. */
export function ensureAgentResources(): Promise<void> {
  const identity = sessionIdentityRevision()
  if (initialization?.identity === identity) return initialization.promise
  const promise = apiClient
    .post<unknown>('/admin/agents/initialize', {})
    .then(() => undefined)
    .catch((error: unknown) => {
      if (initialization?.promise === promise) initialization = null
      throw error
    })
  initialization = { identity, promise }
  return promise
}

function resourceApi<T extends AgentResource>(path: string) {
  return {
    list: async (page: number, pageSize: number, search: string) => {
      await ensureAgentResources()
      return apiClient.get<ResourcePage<T>>(path, {
        query: { page, pageSize, search },
      })
    },
    save: (id: string | null, body: ResourceWrite<T>) =>
      id
        ? apiClient.put<unknown>(`${path}/${encodeURIComponent(id)}`, body)
        : apiClient.post<unknown>(path, body),
    remove: (id: string) =>
      apiClient.delete(`${path}/${encodeURIComponent(id)}`),
  }
}

export const knowledgeBasesApi = {
  ...resourceApi<KnowledgeBase>('/admin/knowledge-bases'),
  searchStatus: () =>
    apiClient.get<{ engine: 'qdrant'; ready: boolean; message: string }>(
      '/admin/knowledge-bases/search-status',
    ),
  index: (id: string) =>
    apiClient.post<{ indexedAssets: number; chunks: number }>(
      `/admin/knowledge-bases/${encodeURIComponent(id)}/index`,
      {},
    ),
}
export const agentSkillsApi = resourceApi<AgentSkill>('/admin/skills')
export const agentToolsApi = {
  list: async (page: number, pageSize: number, search: string) => {
    await ensureAgentResources()
    return apiClient.get<ResourcePage<AgentTool>>('/admin/tools', {
      query: { page, pageSize, search },
    })
  },
  save: (id: string, body: ResourceWrite<AgentTool>) =>
    apiClient.put<unknown>(`/admin/tools/${encodeURIComponent(id)}`, body),
}
