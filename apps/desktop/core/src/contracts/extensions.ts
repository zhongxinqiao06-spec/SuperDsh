/** Public extension metadata. Executable paths and credentials never cross this boundary. */
export type JsonSchema = Record<string, unknown>

export interface ToolImplementation {
  id: string
  name: string
  description: string
  mode: 'read' | 'action' | 'office'
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  configurationSchema: JsonSchema
  permissions: string[]
  artifactTypes: string[]
  timeoutSeconds: number
  guide?: string
  remoteName?: string
  configurationPresets?: {
    id: string
    name: string
    version: string
    values: Record<string, unknown>
  }[]
}

export interface ToolImplementationRef {
  sourceId: string
  version: string
  toolId: string
  digest: string
}

export interface ExtensionManifest {
  schemaVersion: 1
  id: string
  name: string
  version: string
  license: string
  description: string
  runtime: 'node' | 'python' | 'mcp-stdio'
  entrypoint: string
  tools: ToolImplementation[]
  skills?: {
    id: string
    name: string
    description: string
    entrypoint: string
    requiredToolIds: string[]
  }[]
}

export interface ExtensionSource {
  id: string
  name: string
  kind: 'package' | 'mcp-http' | 'builtin'
  enabled: boolean
  revision: number
  activeVersion: string
  status: 'ready' | 'disabled' | 'failed' | 'needs-review'
  diagnostic?: string
  credentialConfigured: boolean
  endpoint?: string
  versions: { version: string; digest: string; createdAt: string }[]
  tools: ToolImplementation[]
  createdAt: string
  skills?: Omit<
    NonNullable<ExtensionManifest['skills']>[number],
    'entrypoint'
  >[]
  updatedAt: string
}

export interface BoundToolImplementation {
  implementation: ToolImplementationRef
  descriptor: ToolImplementation
}
