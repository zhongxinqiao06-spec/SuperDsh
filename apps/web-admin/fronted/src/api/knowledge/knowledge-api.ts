import { request } from '@/utils/request'
import type {
  DocumentStatus,
  EmbeddingDraft,
  EmbeddingSettings,
  KnowledgeBase,
  KnowledgeDraft,
  KnowledgeList,
  KnowledgeSource,
  KnowledgeStatus,
} from '@/types/knowledge/knowledge'

/** 长任务放宽有界等待；失败后读取持久状态，不自动重发副作用请求。 */
export const knowledgeApi = {
  list: (
    page: number,
    pageSize: number,
    search: string,
    signal?: AbortSignal,
  ) =>
    request<KnowledgeList>('/admin/knowledge-bases', {
      query: { page, pageSize, search },
      signal,
    }),
  save: (draft: KnowledgeDraft, id?: string) =>
    request<{ knowledgeBase: KnowledgeBase }>(
      `/admin/knowledge-bases${id ? '/' + encodeURIComponent(id) : ''}`,
      { method: id ? 'PUT' : 'POST', body: draft },
    ),
  delete: (id: string) =>
    request(`/admin/knowledge-bases/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  versions: (id: string, signal?: AbortSignal, page = 1, pageSize = 10) =>
    request<{ items: KnowledgeBase[]; currentVersion: number; total: number }>(
      `/admin/knowledge-bases/${encodeURIComponent(id)}/versions`,
      { signal, query: { page, pageSize } },
    ),
  restore: (id: string, version: number, currentVersion: number) =>
    request(`/admin/knowledge-bases/${encodeURIComponent(id)}/restore`, {
      method: 'POST',
      body: { sourceVersion: version, version: currentVersion },
    }),
  status: (signal?: AbortSignal) =>
    request<KnowledgeStatus>('/admin/knowledge-bases/search-status', {
      signal,
      timeoutMs: 40_000,
    }),
  documents: (id: string, signal?: AbortSignal) =>
    request<{ items: DocumentStatus[] }>(
      `/admin/knowledge-bases/${encodeURIComponent(id)}/index`,
      { signal },
    ),
  index: (id: string, assetId?: string) =>
    request<{ indexedAssets: number; chunks: number }>(
      `/admin/knowledge-bases/${encodeURIComponent(id)}/index`,
      { method: 'POST', body: assetId ? { assetId } : {}, timeoutMs: 250_000 },
    ),
  search: (id: string, query: string, signal?: AbortSignal) =>
    request<{ sources: KnowledgeSource[] }>(
      `/admin/knowledge-bases/${encodeURIComponent(id)}/search`,
      { method: 'POST', body: { query }, signal, timeoutMs: 250_000 },
    ),
  embedding: (signal?: AbortSignal) =>
    request<EmbeddingSettings>('/admin/knowledge-embedding', { signal }),
  saveEmbedding: (draft: EmbeddingDraft) =>
    request<EmbeddingSettings>('/admin/knowledge-embedding', {
      method: 'PUT',
      body: draft,
      timeoutMs: 300_000,
    }),
  prepareLocal: () =>
    request<{ ready: boolean }>('/admin/knowledge-embedding/prepare-local', {
      method: 'POST',
      timeoutMs: 300_000,
    }),
}
