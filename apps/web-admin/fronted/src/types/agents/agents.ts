/** 管理目录和冻结智能体使用同一声明式字段，不包含执行引擎实例。 */
export type AssetKind =
  | 'knowledge'
  | 'spreadsheet-template'
  | 'presentation-template'
  | 'document-template'
export interface AgentAsset {
  id: string
  name: string
  kind: AssetKind
  size: number
  mediaType: string
  sha256: string
  preview: string
  createdAt: string
}
export interface SelectableResource {
  id: string
  name: string
  description: string
  enabled: boolean
  published?: boolean
  version: number
  assetIds?: string[]
  requiredToolIds?: string[]
  program?: object
}
export interface AgentDraft {
  name: string
  description: string
  instructions: string
  recommendedPrompts: string[]
  inputRequirements: string[]
  outputExamples: string[]
  knowledgeBaseIds: string[]
  knowledgeAssetIds: string[]
  templateAssetIds: string[]
  skillIds: string[]
  toolIds: string[]
  published: boolean
  skillPolicy?: { mode: 'legacy' | 'auto' | 'fixed'; fixedSkillId?: string }
  version?: number
}
type OptionalAgentListField =
  | 'recommendedPrompts'
  | 'inputRequirements'
  | 'outputExamples'
  | 'knowledgeBaseIds'
  | 'knowledgeAssetIds'
  | 'templateAssetIds'
  | 'skillIds'
  | 'toolIds'

/** 持久资源和预置示例可省略空列表；编辑时由 agentDraft 补齐，写入契约仍要求完整数组。 */
export interface AgentDefinition
  extends
    Omit<AgentDraft, OptionalAgentListField>,
    Partial<Pick<AgentDraft, OptionalAgentListField>> {
  id: string
  version: number
  createdAt: string
  updatedAt: string
}
export interface AgentCatalog {
  assets: AgentAsset[]
  knowledgeBases: SelectableResource[]
  skills: SelectableResource[]
  tools: SelectableResource[]
}
export interface AgentReadiness {
  ready: boolean
  errors: string[]
  warnings: string[]
  checks: {
    id: string
    status: 'pass' | 'warning' | 'error'
    message: string
  }[]
}
export interface AgentList {
  items: AgentDefinition[]
  total: number
  page: number
  pageSize: number
}
export interface AssetContent {
  name: string
  mediaType: string
  contentBase64: string
}
