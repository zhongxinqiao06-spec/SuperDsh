/** 模型协议标识沿用客户端约定，与应用发布版本无关。 */
export type ModelProtocol =
  'openai-completions' | 'openai-responses' | 'anthropic-messages'
export type ModelAdapter =
  ModelProtocol | 'volcengine-ark' | 'volcengine-speech'
/** 只读检测仅确认模型目录；未确认不能被当作凭据有效或生成能力验证成功。 */
export type ModelVerification = {
  message: string
  serverTime: string
} & ({ ok: true; status: 'verified' } | { ok: false; status: 'unverified' })
export type Capability =
  | 'chat'
  | 'image.generate'
  | 'vision.analyze'
  | 'web.search'
  | 'speech.transcribe'
  | 'speech.synthesize'
  | 'video.generate'
  | 'embedding'
export interface ModelDefinition {
  modelId: string
  name: string
  contextWindow: number | null
  maxTokens: number | null
  inputTypes: ('text' | 'image')[]
}
export interface ProviderDraft {
  name: string
  protocol: ModelProtocol
  baseUrl: string
  models: ModelDefinition[]
  enabled: boolean
  apiKey: string
  clearApiKey: boolean
}
export interface ModelProvider extends Omit<
  ProviderDraft,
  'apiKey' | 'clearApiKey'
> {
  providerId: string
  apiKeyConfigured: boolean
  source: 'personal' | 'platform'
  createdAt: string
  updatedAt: string
}
export interface ModelSelection {
  providerId: string
  modelId: string
}
export interface SupplierSubscription {
  plan?: string
  unit?: string
  quota?: number | null
  remaining?: number | null
}
export interface SupplierInspection {
  /** 配置的 CLI 查询账号；verified 只代表本次请求已通过百炼身份核验。 */
  cliRamAccount?: { name: string; loginName?: string; verified: boolean }
  personalUsage?: { usedRatio: number | null; resetAtMs: number | null }
  quotaItems?: { type: string; quota: number; remaining: number }[]
  quotaError?: string
  checkedAt: string
  models: string[]
  modelError: string
  balances: { currency: string; amount: string }[]
  balanceError: string
}
export interface ConnectionDraft {
  subscription?: SupplierSubscription
  name: string
  adapter: ModelAdapter
  baseUrl: string
  region: string
  enabled: boolean
  revision?: number
  apiKey: string
  clearApiKey: boolean
}
export interface ModelConnection extends Omit<
  ConnectionDraft,
  'apiKey' | 'clearApiKey'
> {
  id: string
  revision: number
  credentialConfigured: boolean
  scope: 'platform'
}
export interface ConfigurationDraft {
  name: string
  connectionId: string
  capability: Capability
  modelId: string
  revision?: number
  enabled: boolean
  parameters: Record<string, string | number>
  roleIds: string[]
}
export interface ModelConfiguration extends ConfigurationDraft {
  id: string
  revision: number
  kind: 'chat' | 'multimodal'
}
export interface ParameterSchema {
  type: 'integer' | 'string'
  title?: string
  minimum?: number
  maximum?: number
  default?: string | number
  enum?: string[]
  'x-superdsh-adapters'?: ModelAdapter[]
}
export interface ModelCapability {
  id: Capability
  name: string
  available: boolean
  configurationSchema: { properties: Record<string, ParameterSchema> }
}
export interface CapabilityDefault {
  capability: Capability
  configurationId: string | null
  revision: number
}
export interface ModelCatalog {
  configurations: ModelConfiguration[]
  connections: ModelConnection[]
  capabilities: ModelCapability[]
  defaults: CapabilityDefault[]
}
