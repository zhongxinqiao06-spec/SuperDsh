import { apiClient } from '@/lib/api'

import type { EmbeddingProfile } from '@superdsh/core/contracts/office'
export type { EmbeddingProfile } from '@superdsh/core/contracts/office'
export type EmbeddingSettings = {
  version: number
  profile: EmbeddingProfile
  localDefault: EmbeddingProfile
}
export type KnowledgeDocumentStatus = {
  assetId: string
  sha256: string
  filename: string
  state: 'pending' | 'indexing' | 'ready' | 'failed'
  generation: string
  chunks: number
  message?: string
}
export type KnowledgeSource = {
  sourceId: string
  assetId: string
  filename: string
  content: string
  sha256: string
  location: {
    heading?: string
    page?: number
    paragraph?: number
    sheet?: string
    row?: number
    line?: number
  }
}

export const knowledgeApi = {
  settings: () =>
    apiClient.get<EmbeddingSettings>('/admin/knowledge-embedding'),
  saveSettings: (body: {
    version: number
    kind: EmbeddingProfile['kind']
    model?: string
    dimensions?: number
    revision?: string
    baseUrl?: string
    apiKey?: string
  }) => apiClient.put<EmbeddingSettings>('/admin/knowledge-embedding', body),
  prepareLocal: () =>
    apiClient.post<{ ready: boolean }>(
      '/admin/knowledge-embedding/prepare-local',
      {},
    ),
  documents: (id: string) =>
    apiClient.get<{ items: KnowledgeDocumentStatus[] }>(
      `/admin/knowledge-bases/${encodeURIComponent(id)}/index`,
    ),
  retry: (id: string, assetId: string) =>
    apiClient.post<{ indexedAssets: number; chunks: number }>(
      `/admin/knowledge-bases/${encodeURIComponent(id)}/index`,
      { assetId },
    ),
  search: (id: string, query: string) =>
    apiClient.post<{ sources: KnowledgeSource[] }>(
      `/admin/knowledge-bases/${encodeURIComponent(id)}/search`,
      { query },
    ),
}
