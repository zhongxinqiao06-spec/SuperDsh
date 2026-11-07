import type { BoundToolImplementation } from '@superdsh/core/contracts/extensions'

export interface AgentResource {
  id: string
  name: string
  description: string
  enabled: boolean
  version: number
  createdAt: string
  updatedAt: string
}

export interface KnowledgeBase extends AgentResource {
  assetIds: string[]
}

export interface AgentSkill extends AgentResource {
  program?: import('@superdsh/core/contracts/skills').SkillProgram
  programDraft?: import('@superdsh/core/contracts/skills').SkillProgram | null
  instructions: string
  requiredToolIds: string[]
  references?: { path: string; assetId: string; sha256: string }[]
  packageSha256?: string
}

export type AgentToolId = string

export interface AgentToolConfig
  extends AgentResource, Partial<BoundToolImplementation> {
  id: AgentToolId
  configuredSecrets?: string[]
  settings: {
    [key: string]: unknown
    companyName?: string
    title?: string
    maxResults?: number
  }
}

export interface AgentResourceCatalog {
  knowledgeBases: KnowledgeBase[]
  skills: AgentSkill[]
  tools: AgentToolConfig[]
}

export type AgentResourceKind = 'knowledge-bases' | 'skills' | 'tools'
