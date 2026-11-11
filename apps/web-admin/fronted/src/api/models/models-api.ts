import { request } from '@/utils/request'
import type {
  Capability,
  ConfigurationDraft,
  ConnectionDraft,
  ModelCatalog,
  ModelConfiguration,
  ModelConnection,
  ModelProvider,
  ModelSelection,
  ModelVerification,
  ProviderDraft,
} from '@/types/models/models'

/** 模型页面只调用无版本业务路径；密钥编辑空值由服务端保留。 */
export const modelsApi = {
  providers: (personal: boolean, signal?: AbortSignal) =>
    request<{ providers: ModelProvider[] }>(
      `${personal ? '/models/personal' : '/admin/models'}/providers`,
      { signal },
    ),
  selection: (personal: boolean, signal?: AbortSignal) =>
    request<{ selection: ModelSelection | null }>(
      `${personal ? '/models/personal' : '/admin/models'}/default`,
      { signal },
    ),
  saveProvider: (personal: boolean, draft: ProviderDraft, id?: string) =>
    request<ModelProvider>(
      `${personal ? '/models/personal' : '/admin/models'}/providers${id ? '/' + encodeURIComponent(id) : ''}`,
      { method: id ? 'PATCH' : 'POST', body: draft },
    ),
  deleteProvider: (personal: boolean, id: string) =>
    request<{ ok: boolean }>(
      `${personal ? '/models/personal' : '/admin/models'}/providers/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
  setSelection: (personal: boolean, selection: ModelSelection | null) =>
    request(`${personal ? '/models/personal' : '/admin/models'}/default`, {
      method: 'PUT',
      body: { selection },
    }),
  verifyProvider: (personal: boolean, id: string) =>
    request<ModelVerification>(
      `${personal ? '/models/personal' : '/admin/models'}/providers/${encodeURIComponent(id)}/verify`,
      { method: 'POST', timeoutMs: 35_000 },
    ),
  catalog: (signal?: AbortSignal) =>
    request<ModelCatalog>('/admin/models/configurations', { signal }),
  saveConnection: (draft: ConnectionDraft, id?: string) =>
    request<ModelConnection>(
      `/admin/models/connections${id ? '/' + encodeURIComponent(id) : ''}`,
      { method: id ? 'PATCH' : 'POST', body: draft },
    ),
  saveConfiguration: (draft: ConfigurationDraft, id?: string) =>
    request<ModelConfiguration>(
      `/admin/models/configurations${id ? '/' + encodeURIComponent(id) : ''}`,
      { method: id ? 'PATCH' : 'POST', body: draft },
    ),
  verifyConfiguration: (id: string) =>
    request<ModelVerification>(
      `/admin/models/configurations/${encodeURIComponent(id)}/verify`,
      { method: 'POST', timeoutMs: 35_000 },
    ),
  setDefault: (
    capability: Capability,
    configurationId: string | null,
    revision: number,
  ) =>
    request(`/admin/models/defaults/${encodeURIComponent(capability)}`, {
      method: 'PUT',
      body: { configurationId, revision },
    }),
}
