import { apiClient } from '@/lib/api'

export type ModelProtocol =
  'openai-completions' | 'openai-responses' | 'anthropic-messages'
export type PlatformModel = {
  modelId: string
  name: string
  contextWindow?: number | null
  maxTokens?: number | null
  inputTypes?: ('text' | 'image')[]
}
export type ModelProvider = {
  providerId: string
  name: string
  protocol: ModelProtocol
  baseUrl: string
  models: PlatformModel[]
  enabled: boolean
  apiKeyConfigured: boolean
  createdAt: string
  updatedAt: string
}
export type ProviderWrite = Pick<
  ModelProvider,
  'name' | 'protocol' | 'baseUrl' | 'models' | 'enabled'
> & { apiKey?: string; clearApiKey?: boolean }
export type ModelSelection = { providerId: string; modelId: string }
function modelApi(scope: 'platform' | 'personal') {
  const base = scope === 'personal' ? '/models/personal' : '/admin/models'
  return {
    providers: () =>
      apiClient.get<{ providers: ModelProvider[] }>(`${base}/providers`),
    save: (id: string | null, body: ProviderWrite) =>
      id
        ? apiClient.patch<ModelProvider>(
            `${base}/providers/${encodeURIComponent(id)}`,
            body,
          )
        : apiClient.post<ModelProvider>(`${base}/providers`, body),
    remove: (id: string) =>
      apiClient.delete(`${base}/providers/${encodeURIComponent(id)}`),
    verify: (id: string) =>
      apiClient.post<{ ok: boolean }>(
        `${base}/providers/${encodeURIComponent(id)}/verify`,
        {},
      ),
    defaultSelection: () =>
      apiClient.get<{ selection: ModelSelection | null }>(`${base}/default`),
    setDefault: (selection: ModelSelection | null) =>
      apiClient.put(`${base}/default`, { selection }),
  }
}
export const modelsApi = modelApi('platform')
export const personalModelsApi = modelApi('personal')
