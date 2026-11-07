/** Product model metadata. Credentials and provider file IDs are server-only. */
export type ModelCapability =
  | 'chat'
  | 'image.generate'
  | 'vision.analyze'
  | 'speech.transcribe'
  | 'speech.synthesize'
  | 'video.generate'
  | 'embedding'

export type ModelAdapter =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'volcengine-ark'
  | 'volcengine-speech'

export interface CapabilityDescriptor {
  id: ModelCapability
  name: string
  available: boolean
  inputTypes: string[]
  outputTypes: string[]
  configurationSchema: Record<string, unknown>
  cancellation: 'abort-request' | 'queued-only' | 'unsupported'
}

export interface ProviderConnection {
  id: string
  name: string
  adapter: ModelAdapter
  baseUrl: string
  region: string
  enabled: boolean
  revision: number
  credentialConfigured: boolean
  scope: 'platform' | 'personal'
}

export interface ModelConfiguration {
  id: string
  name: string
  kind: 'chat' | 'multimodal'
  capability: ModelCapability
  connectionId: string
  modelId: string
  revision: number
  enabled: boolean
  parameters: Record<string, unknown>
  roleIds: string[]
}

export interface CapabilityBinding {
  configurationId: string
  revision: number
  capability: ModelCapability
}

export interface ModelDefaultBinding {
  capability: ModelCapability
  configurationId: string | null
  revision: number
}

export interface ProviderOperation {
  id: string
  sessionId: string
  binding: CapabilityBinding
  state:
    | 'submitting'
    | 'running'
    | 'result-pending'
    | 'completed'
    | 'failed'
    | 'submission-unknown'
    | 'timed-out'
    | 'cancel-requested'
    | 'cancelled'
  providerRequestId?: string
  error?: string
  usage?: Record<string, unknown>
  createdAt: string
  updatedAt: string
}
