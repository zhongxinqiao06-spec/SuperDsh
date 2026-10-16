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
  instructions: string
  requiredToolIds: string[]
}

export type AgentToolId =
  'knowledge_search' | 'spreadsheet_report' | 'presentation_report'

export interface AgentToolConfig extends AgentResource {
  id: AgentToolId
  settings: {
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
