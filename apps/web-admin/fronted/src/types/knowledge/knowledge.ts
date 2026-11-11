import type { SelectableResource } from '@/types/agents/agents'

/** 知识库只保存资料引用，索引状态属于具体文件与模型代际。 */
export interface KnowledgeDraft {
  name: string
  description: string
  assetIds: string[]
  enabled: boolean
  version?: number
}
export interface KnowledgeBase extends SelectableResource {
  assetIds: string[]
  createdAt: string
  updatedAt: string
}
export interface KnowledgeList {
  items: KnowledgeBase[]
  total: number
  page: number
  pageSize: number
}
export interface KnowledgeStatus {
  engine: 'qdrant'
  ready: boolean
  generation?: string
  message: string
}
export interface DocumentStatus {
  assetId: string
  sha256: string
  filename: string
  generation: string
  state: 'pending' | 'indexing' | 'ready' | 'failed'
  chunks: number
  message?: string
  operationId?: string
}
export interface KnowledgeSource {
  sourceId: string
  assetId: string
  filename: string
  sha256: string
  content: string
  paragraph: number
  location: {
    page?: number
    paragraph?: number
    line?: number
    sheet?: string
    row?: number
    heading?: string
    offset?: number
  }
}
export interface EmbeddingProfile {
  id: string
  kind: 'local' | 'openai-compatible'
  model: string
  dimensions: number
  revision: string
  baseUrl?: string
  apiKeyConfigured?: boolean
}
export interface EmbeddingSettings {
  version: number
  profile: EmbeddingProfile
  localDefault: EmbeddingProfile
}
export interface EmbeddingDraft {
  version: number
  kind: 'local' | 'openai-compatible'
  model: string
  dimensions: number
  revision: string
  baseUrl: string
  apiKey: string
  clearApiKey: boolean
}
