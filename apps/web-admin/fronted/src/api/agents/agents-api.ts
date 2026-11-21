import { productRequest } from '@/api/console/product-request'
import type { Product } from '@/types/console/navigation'

import type {
  AgentCatalog,
  AgentDefinition,
  AgentDraft,
  AgentList,
  AgentReadiness,
  AgentAsset,
  AssetContent,
  AssetKind,
} from '@/types/agents/agents'

/** 管理与工作台使用规范路径，文件内容保持现有资产协议。 */
export function createAgentsApi(product: Product) {
  const request = productRequest(product)
  return {
    list: (
      page: number,
      pageSize: number,
      search: string,
      signal?: AbortSignal,
    ) =>
      request<AgentList>('/admin/agents', {
        query: { page, pageSize, search },
        signal,
      }),
    catalog: (signal?: AbortSignal) =>
      request<AgentCatalog>('/admin/agents/catalog', { signal }),
    save: (draft: AgentDraft, id?: string) =>
      request<{ agent: AgentDefinition }>(
        `/admin/agents${id ? '/' + encodeURIComponent(id) : ''}`,
        { method: id ? 'PUT' : 'POST', body: draft },
      ),
    delete: (id: string) =>
      request(`/admin/agents/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    readiness: (id: string, signal?: AbortSignal) =>
      request<AgentReadiness>(
        `/admin/agents/${encodeURIComponent(id)}/readiness`,
        { signal },
      ),
    initialize: (copyLatest = false) =>
      request('/admin/agents/initialize', {
        method: 'POST',
        body: { copyLatest },
      }),
    upload: (name: string, kind: AssetKind, contentBase64: string) =>
      request<{ asset: AgentAsset }>('/admin/agents/assets', {
        method: 'POST',
        body: { name, kind, contentBase64 },
      }),
    download: (id: string, signal?: AbortSignal) =>
      request<AssetContent>(
        `/admin/agents/assets/${encodeURIComponent(id)}/download`,
        { signal },
      ),
    preview: (id: string, signal?: AbortSignal) =>
      request<AssetContent>(
        `/admin/agents/assets/${encodeURIComponent(id)}/preview`,
        { signal },
      ),
  }
}
