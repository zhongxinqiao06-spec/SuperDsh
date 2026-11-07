import type {
  ExtensionSource,
  ToolImplementation,
} from '@superdsh/core/contracts/extensions'
import { apiClient } from '@/lib/api'

export const extensionsApi = {
  list: () => apiClient.get<{ items: ExtensionSource[] }>('/admin/extensions'),
  check: (source: ExtensionSource) =>
    apiClient.post(`/admin/extensions/${encodeURIComponent(source.id)}/check`, {
      version: source.activeVersion,
    }),
  install: (
    contentBase64: string,
    revision?: number,
    expectedSourceId?: string,
  ) =>
    apiClient.post('/admin/extensions/install', {
      contentBase64,
      revision,
      expectedSourceId,
    }),
  discover: (endpoint: string, token?: string, id?: string) =>
    apiClient.post<{ tools: ToolImplementation[]; discoveryDigest: string }>(
      '/admin/extensions/mcp/discover',
      { endpoint, token, id },
    ),
  connect: (body: {
    id: string
    name: string
    endpoint: string
    token?: string
    version: string
    selectedToolIds: string[]
    discoveryDigest: string
    revision?: number
  }) => apiClient.post('/admin/extensions/mcp', body),
  update: (
    source: ExtensionSource,
    enabled: boolean,
    version = source.activeVersion,
  ) =>
    apiClient.put(`/admin/extensions/${encodeURIComponent(source.id)}`, {
      enabled,
      version,
      revision: source.revision,
    }),
}
