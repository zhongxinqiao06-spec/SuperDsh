import { apiClient } from '@/lib/api'
import { sessionIdentityRevision } from '@/features/auth/session'
import type { BoundToolImplementation } from '@superdsh/core/contracts/extensions'

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
  program?: import('@superdsh/core/contracts/skills').SkillProgram
  programDraft?: import('@superdsh/core/contracts/skills').SkillProgram | null
  instructions: string
  requiredToolIds: string[]
  references?: { path: string; assetId: string; sha256: string }[]
  packageSha256?: string
}
export type AgentTool = AgentResource &
  Partial<BoundToolImplementation> & {
    configuredSecrets?: string[]
    settings: Record<string, unknown> & {
      companyName?: string
      title?: string
      maxResults?: number
    }
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
    versions: (id: string, page: number, pageSize: number) =>
      apiClient.get<ResourcePage<T> & { currentVersion: number }>(
        `${path}/${encodeURIComponent(id)}/versions`,
        { query: { page, pageSize } },
      ),
    restore: (id: string, sourceVersion: number, version: number) =>
      apiClient.post(`${path}/${encodeURIComponent(id)}/restore`, {
        sourceVersion,
        version,
      }),
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
export const agentSkillsApi = {
  publish: (id: string, version: number) =>
    apiClient.post(`/admin/skills/${encodeURIComponent(id)}/publish`, {
      version,
    }),
  matchPreview: (request: string) =>
    apiClient.post<{
      candidates: {
        id: string
        name: string
        score: number
        reasons: string[]
      }[]
    }>('/admin/skills/match-preview', { request }),
  ...resourceApi<AgentSkill>('/admin/skills'),
  importExtension: (
    sourceId: string,
    sourceVersion: string,
    skillId: string,
    requiredToolIds: string[],
  ) =>
    apiClient.post<{ skill: AgentSkill }>('/admin/skills/import-extension', {
      sourceId,
      sourceVersion,
      skillId,
      requiredToolIds,
    }),
  importPackage: (contentBase64: string, requiredToolIds: string[]) =>
    apiClient.post<{ skill: AgentSkill }>('/admin/skills/import', {
      contentBase64,
      requiredToolIds,
    }),
}
export const agentToolsApi = resourceApi<AgentTool>('/admin/tools')
