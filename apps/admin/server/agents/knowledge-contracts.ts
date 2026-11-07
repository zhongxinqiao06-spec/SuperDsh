import type {
  KnowledgeLocation,
  EmbeddingProfile,
} from '@superdsh/core/contracts/office'
export type {
  KnowledgeLocation,
  EmbeddingProfile,
} from '@superdsh/core/contracts/office'

export interface KnowledgeSegment {
  text: string
  location: KnowledgeLocation
}

export interface KnowledgeEmbedding {
  profile: EmbeddingProfile
  ready(signal?: AbortSignal): Promise<void>
  embed(
    texts: string[],
    purpose: 'query' | 'document',
    signal?: AbortSignal,
  ): Promise<number[][]>
}

export interface KnowledgeDocumentStatus {
  assetId: string
  sha256: string
  filename: string
  state: 'pending' | 'indexing' | 'ready' | 'failed'
  generation: string
  chunks: number
  message?: string
}
