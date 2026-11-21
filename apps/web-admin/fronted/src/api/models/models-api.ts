import { request } from '@/utils/request'
import type { SupplierInspection } from '@/types/models/models'
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

/** 直接通过公网 IP 的 HTTP 页面也可管理模型列表，密钥操作需要加密传输。 */
export function checkKeyTransport(): void {
  if (
    location.protocol !== 'https:' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
  )
    throw new Error('查看或更换 API Key 请使用 HTTPS 管理入口')
}

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
      { method: 'POST' },
    ),
  catalog: (signal?: AbortSignal) =>
    request<ModelCatalog>('/admin/models/configurations', { signal }),
  revealKey: (id: string, passwordVerifier: string, signal: AbortSignal) =>
    request<{ apiKey: string }>(
      '/admin/models/connections/' + encodeURIComponent(id) + '/reveal-key',
      { method: 'POST', body: { passwordVerifier }, signal },
    ),
  inspectConnection: (id: string, signal: AbortSignal) =>
    request<SupplierInspection>(
      '/admin/models/connections/' + encodeURIComponent(id) + '/inspect',
      { method: 'POST', signal },
    ),
  saveConnection: (
    draft: ConnectionDraft,
    id?: string,
    passwordVerifier?: string,
  ) =>
    request<ModelConnection>(
      `/admin/models/connections${id ? '/' + encodeURIComponent(id) : ''}`,
      { method: id ? 'PATCH' : 'POST', body: { ...draft, passwordVerifier } },
    ),
  saveConfiguration: (draft: ConfigurationDraft, id?: string) =>
    request<ModelConfiguration>(
      `/admin/models/configurations${id ? '/' + encodeURIComponent(id) : ''}`,
      { method: id ? 'PATCH' : 'POST', body: draft },
    ),
  verifyConfiguration: (id: string) =>
    request<ModelVerification>(
      `/admin/models/configurations/${encodeURIComponent(id)}/verify`,
      { method: 'POST' },
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
