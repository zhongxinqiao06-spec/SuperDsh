import { productRequest } from '@/api/console/product-request'
import type { Product } from '@/types/console/navigation'
import { request as platformRequest } from '@/utils/request'
import type {
  CapabilityChoice,
  ExtensionSource,
  McpDiscovery,
  McpDraft,
  ResourceHistory,
  ResourcePage,
  ToolDraft,
  ToolResource,
} from '@/types/tools/tools'
/** 工具来源与工具配置使用各自权限端点；版本冲突由服务端返回409。 */
export function createToolsApi(product: Product) {
  const request = productRequest(product)
  return {
    list: (
      page: number,
      pageSize: number,
      search: string,
      signal?: AbortSignal,
    ) =>
      request<ResourcePage<ToolResource>>('/admin/tools', {
        query: { page, pageSize, search },
        signal,
      }),
    save: (body: ToolDraft, id?: string) =>
      request<{ tool: ToolResource }>(
        `/admin/tools${id ? '/' + encodeURIComponent(id) : ''}`,
        { method: id ? 'PUT' : 'POST', body },
      ),
    delete: (id: string) =>
      request<void>(`/admin/tools/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    versions: (id: string, page: number, signal?: AbortSignal) =>
      request<ResourceHistory<ToolResource>>(
        `/admin/tools/${encodeURIComponent(id)}/versions`,
        { query: { page, pageSize: 10 }, signal },
      ),
    restore: (id: string, version: number, sourceVersion: number) =>
      request(`/admin/tools/${encodeURIComponent(id)}/restore`, {
        method: 'POST',
        body: { version, sourceVersion },
      }),
    sources: async (signal?: AbortSignal) =>
      (
        await request<{ items: ExtensionSource[] }>('/admin/tools/sources', {
          signal,
        })
      ).items,
    capabilities: (signal?: AbortSignal) =>
      request<{ configurations: CapabilityChoice[] }>('/models/capabilities', {
        signal,
      }),
  }
}

/** 扩展包安装与 MCP 凭据由平台管理入口使用。 */
export const toolsApi = {
  sources: async (signal?: AbortSignal) =>
    (
      await platformRequest<{ items: ExtensionSource[] }>('/admin/extensions', {
        signal,
      })
    ).items,
  install: (
    contentBase64: string,
    revision?: number,
    expectedSourceId?: string,
  ) =>
    platformRequest('/admin/extensions/install', {
      method: 'POST',
      body: { contentBase64, revision, expectedSourceId },
      timeoutMs: 120_000,
    }),
  updateSource: (
    id: string,
    revision: number,
    enabled: boolean,
    version: string,
  ) =>
    platformRequest(`/admin/extensions/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: { revision, enabled, version },
      timeoutMs: 60_000,
    }),
  checkSource: (id: string, version: string) =>
    platformRequest(`/admin/extensions/${encodeURIComponent(id)}/check`, {
      method: 'POST',
      body: { version },
      timeoutMs: 60_000,
    }),
  discover: (body: Pick<McpDraft, 'endpoint' | 'token'> & { id?: string }) =>
    platformRequest<McpDiscovery>('/admin/extensions/mcp/discover', {
      method: 'POST',
      body,
      timeoutMs: 60_000,
    }),
  connect: (body: McpDraft) =>
    platformRequest('/admin/extensions/mcp', {
      method: 'POST',
      body,
      timeoutMs: 60_000,
    }),
}
