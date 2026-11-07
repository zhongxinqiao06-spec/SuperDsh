/** Product API v2 extensions. Never contain model keys, file bytes or approval tokens. */
export interface OfficeSource {
  id: string
  kind: 'asset' | 'attachment' | 'artifact'
  role: 'input' | 'template' | 'image' | 'knowledge'
  name: string
  sha256: string
  size: number
}

export interface OfficePlan {
  skillRunId?: string
  skillRevision?: number
  id: string
  sessionId: string
  bindingVersion?: number
  agentDefinition?: { id: string; name: string; version: number }
  tool: string
  version: number
  sha256: string
  title: string
  document: Record<string, unknown>
  sources: OfficeSource[]
  summary: string
  warnings: string[]
  state:
    | 'prepared'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted'
    | 'timed-out'
  stage?: 'planning' | 'generating' | 'rendering' | 'checking' | 'complete'
  result?: Record<string, unknown>
  previousArtifactId?: string
  artifactId?: string
  error?: string
  createdAt: string
  updatedAt: string
}

export interface ArtifactRevision {
  skillRunId?: string
  skillRevision?: number
  bindingVersion?: number
  planId: string
  planVersion: number
  planHash: string
  previousArtifactId?: string
  inputSources: OfficeSource[]
  agentVersion: number
  skillVersions: { id: string; version: number }[]
  toolVersions: { id: string; version: number }[]
  dependencies?: {
    sourceId: string
    version: string
    toolId: string
    digest: string
  }[]
}

export interface KnowledgeLocation {
  paragraph?: number
  heading?: string
  page?: number
  sheet?: string
  row?: number
  line?: number
  offset?: number
}

export interface SourceReference {
  sourceId: string
  assetId: string
  filename: string
  /** Zero means an older source did not retain an original paragraph location. */
  paragraph: number
  sha256: string
  content: string
  location: KnowledgeLocation
}

export interface EmbeddingProfile {
  id: string
  kind: 'local' | 'openai-compatible'
  model: string
  dimensions: number
  revision: string
  baseUrl?: string
  apiKeyConfigured?: boolean
}
