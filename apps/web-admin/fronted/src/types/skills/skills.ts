import type { JsonSchema, ResourceBase } from '@/types/tools/tools'
/** 技能程序为可配置数据，不创建第二执行队列或业务专用流程。 */
export interface MatchRules {
  phrases: string[]
  excludePhrases: string[]
  inputExtensions: string[]
  outputTypes: string[]
  examples: string[]
}
export interface SkillStage {
  id: string
  name: string
  instructions: string
  skillId?: string | null
  operation: 'submit' | 'inspect' | 'prepare' | 'execute' | 'review'
  toolIds: string[]
  inspectToolIds: string[]
  outputSchema: JsonSchema
  checks: string[]
}
export interface SkillProgram {
  schemaVersion: 1
  match: MatchRules
  stages: SkillStage[]
  maxRevisions: number
  timeoutSeconds: number
}
export interface SkillReference {
  path: string
  assetId: string
  sha256: string
}
export interface SkillDraft {
  name: string
  description: string
  enabled: boolean
  instructions: string
  requiredToolIds: string[]
  version?: number
  programDraft?: SkillProgram | null
  references?: SkillReference[]
  packageSha256?: string | null
}
export interface SkillResource extends ResourceBase, SkillDraft {
  version: number
  program?: SkillProgram | null
  programDraft?: SkillProgram | null
  references?: SkillReference[]
}
export interface SkillCandidate {
  id: string
  name: string
  description: string
  score: number
  reasons: string[]
  outputTypes: string[]
  examples: string[]
}
