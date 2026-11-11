/** 扩展声明由服务端提供，工具配置绑定来源、版本和内容摘要。 */
export interface JsonSchema {
  type?: string | string[]
  title?: string
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: unknown[]
  default?: unknown
  writeOnly?: boolean
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
  $ref?: string
  $defs?: Record<string, JsonSchema>
  allOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  anyOf?: JsonSchema[]
  additionalProperties?: boolean | JsonSchema
  'x-superdsh-capability'?: string
}
export interface ImplementationRef {
  sourceId: string
  version: string
  toolId: string
  digest: string
}
export interface ToolDescriptor {
  id: string
  name: string
  description: string
  permissions: string[]
  timeoutSeconds: number
  inputSchema: JsonSchema
  outputSchema: JsonSchema
  configurationSchema: JsonSchema
  configurationPresets?: Array<{
    id: string
    name: string
    version: string
    values: Record<string, unknown>
  }>
}
export interface ExtensionSource {
  id: string
  name: string
  kind: string
  enabled: boolean
  revision: number
  activeVersion: string
  status: string
  diagnostic?: string
  credentialConfigured: boolean
  endpoint?: string
  tools: ToolDescriptor[]
  skills?: Array<{
    id: string
    name: string
    description: string
    requiredToolIds: string[]
  }>
  versions: Array<{ version: string; digest: string; createdAt: string }>
  createdAt: string
  updatedAt: string
}
export interface ResourceBase {
  id: string
  name: string
  description: string
  enabled: boolean
  published: boolean
  version: number
  createdAt: string
  updatedAt: string
}
export interface ToolResource extends ResourceBase {
  implementation: ImplementationRef
  settings: Record<string, unknown>
  descriptor?: ToolDescriptor
  configuredSecrets?: string[]
}
export interface ToolDraft {
  name: string
  description: string
  enabled: boolean
  version?: number
  implementation: ImplementationRef
  settings: Record<string, unknown>
}
export interface ResourcePage<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}
export interface ResourceHistory<T> {
  items: T[]
  total: number
  currentVersion: number
  page: number
  pageSize: number
}
export interface McpDiscovery {
  tools: ToolDescriptor[]
  discoveryDigest: string
}
export interface McpDraft {
  id: string
  name: string
  endpoint: string
  version: string
  token?: string
  revision?: number
  discoveryDigest: string
  selectedToolIds: string[]
}
export interface CapabilityChoice {
  id: string
  name: string
  capability: string
  modelId: string
  revision: number
}
