import type { JsonSchema } from './extensions.js'

/** Product-owned stage data. DSH remains the only execution loop. */
export type SkillOperation =
  'submit' | 'inspect' | 'prepare' | 'execute' | 'review'
export interface SkillStageDefinition {
  id: string
  name: string
  instructions: string
  skillId?: string
  operation: SkillOperation
  toolIds: string[]
  outputSchema: JsonSchema
  checks: ('schema' | 'sources' | 'plan' | 'artifact' | 'rendered-quality')[]
}
export interface SkillProgram {
  schemaVersion: 1
  match: {
    phrases: string[]
    excludePhrases: string[]
    inputExtensions: string[]
    outputTypes: string[]
    examples: string[]
  }
  stages: SkillStageDefinition[]
  maxRevisions: number
  timeoutSeconds: number
}
export interface SkillPolicy {
  mode: 'legacy' | 'auto' | 'fixed'
  fixedSkillId?: string
}
export type SkillRunState =
  | 'running'
  | 'waiting-user'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'timed-out'
  | 'needs-revision'
export interface SkillCheckResult {
  validator: string
  version: number
  passed: boolean
  message: string
  evidenceHash?: string
}
export interface SkillStageRun {
  id: string
  name: string
  skillId: string
  skillVersion: number
  operation: SkillOperation
  attempt: number
  state: 'pending' | SkillRunState
  output?: Record<string, unknown>
  checks: SkillCheckResult[]
  calls: {
    callId: string
    tool: string
    phase: string
    state: string
    planId?: string
    artifactIds?: string[]
  }[]
  startedAt?: string
  endedAt?: string
  error?: string
}
export interface SkillRun {
  activeRequestId?: string
  id: string
  sessionId: string
  bindingVersion: number
  skillId: string
  skillName: string
  skillVersion: number
  requestId: string
  request: string
  version: number
  revision: number
  state: SkillRunState
  stageIndex: number
  stages: SkillStageRun[]
  history: SkillStageRun[]
  selection: {
    reason: string
    candidates: { id: string; name: string; score: number; reasons: string[] }[]
  }
  program: SkillProgram
  createdAt: string
  updatedAt: string
}
