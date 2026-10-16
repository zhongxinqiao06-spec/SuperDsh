import { apiClient } from '@/lib/api'
import {
  ensureAgentResources,
  type AgentSkill,
  type AgentTool,
  type KnowledgeBase,
} from './resources-api'

export type AgentAssetKind =
  'knowledge' | 'spreadsheet-template' | 'presentation-template'

export type AgentAsset = {
  id: string
  name: string
  kind: AgentAssetKind
  size: number
  preview: string
  sha256: string
  createdAt: string
}

export type AgentDefinition = {
  id: string
  name: string
  description: string
  instructions: string
  knowledgeBaseIds: string[]
  knowledgeAssetIds: string[]
  templateAssetIds: string[]
  skillIds: string[]
  toolIds: string[]
  published: boolean
  version: number
  createdAt: string
  updatedAt: string
}

export type AgentDefinitionWrite = Omit<
  AgentDefinition,
  'id' | 'createdAt' | 'updatedAt' | 'version'
> & { version?: number }

export type AgentCapability = { id: string; name: string; description: string }
export type AgentCatalog = {
  assets: AgentAsset[]
  knowledgeBases: KnowledgeBase[]
  skills: AgentSkill[]
  tools: AgentTool[]
}

export type AgentDownload = {
  contentBase64: string
  name: string
  mediaType: string
}
export type AgentAssetPreview = AgentDownload & {
  mediaType: 'application/pdf'
  missingFonts?: string[]
}
export type AgentArtifact = {
  fileId: string
  name: string
  mediaType: string
  size: number
  createdAt: string
}
export type AgentSessionArtifacts = {
  items: AgentArtifact[]
  agentDefinition: { id: string; name: string; version: number } | null
}

export const agentsApi = {
  available: () =>
    apiClient.get<{ items: AgentDefinition[]; total: number }>('/agents'),
  list: async (page: number, pageSize: number, search: string) => {
    await ensureAgentResources()
    return apiClient.get<{ items: AgentDefinition[]; total: number }>(
      '/admin/agents',
      {
        query: { page, pageSize, search },
      },
    )
  },
  catalog: async () => {
    await ensureAgentResources()
    return apiClient.get<AgentCatalog>('/admin/agents/catalog')
  },
  save: (id: string | null, body: AgentDefinitionWrite) =>
    id
      ? apiClient.put<{ agent: AgentDefinition }>(
          `/admin/agents/${encodeURIComponent(id)}`,
          body,
        )
      : apiClient.post<{ agent: AgentDefinition }>('/admin/agents', body),
  remove: (id: string) =>
    apiClient.delete(`/admin/agents/${encodeURIComponent(id)}`),
  seedDemo: () =>
    apiClient.post<{ agents: AgentDefinition[]; assets: AgentAsset[] }>(
      '/admin/agents/demo',
      {},
    ),
  upload: (body: {
    name: string
    kind: AgentAssetKind
    contentBase64: string
  }) => apiClient.post<{ asset: AgentAsset }>('/admin/agents/assets', body),
  downloadAsset: (id: string) =>
    apiClient.get<AgentDownload>(
      `/admin/agents/assets/${encodeURIComponent(id)}/download`,
    ),
  previewAsset: (id: string, signal?: AbortSignal) =>
    apiClient.get<AgentAssetPreview>(
      `/admin/agents/assets/${encodeURIComponent(id)}/preview`,
      { signal },
    ),
  artifacts: (sessionId: string) =>
    apiClient.get<AgentSessionArtifacts>(
      `/sessions/${encodeURIComponent(sessionId)}/agent-artifacts`,
    ),
  downloadArtifact: (sessionId: string, fileId: string) =>
    apiClient.get<AgentDownload>(
      `/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(fileId)}`,
    ),
}

export function saveAgentDownload(file: AgentDownload) {
  const bytes = Uint8Array.from(atob(file.contentBase64), (char) =>
    char.charCodeAt(0),
  )
  const url = URL.createObjectURL(new Blob([bytes], { type: file.mediaType }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = file.name
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function emptyAgentDefinition(): AgentDefinitionWrite {
  return {
    name: '',
    description: '',
    instructions: '',
    knowledgeBaseIds: [],
    knowledgeAssetIds: [],
    templateAssetIds: [],
    skillIds: [],
    toolIds: [],
    published: false,
  }
}

export function editableAgent(agent: AgentDefinition): AgentDefinitionWrite {
  return {
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    knowledgeBaseIds: [...(agent.knowledgeBaseIds ?? [])],
    knowledgeAssetIds: [...agent.knowledgeAssetIds],
    templateAssetIds: [...agent.templateAssetIds],
    skillIds: [...agent.skillIds],
    toolIds: [...agent.toolIds],
    published: agent.published,
    version: agent.version,
  }
}
