import type { Job, StudioDocument } from './studio'

/** 阶段状态来自服务端确认指纹，不以访问页面或表单非空伪装完成。 */
export type PreparationStage = 'script' | 'cast' | 'storyboard' | 'sample'
export interface StageState {
  key: PreparationStage
  title: string
  status: 'confirmed' | 'skipped' | 'stale' | 'blocked' | 'needs_review'
  issues: {
    key: string
    message: string
    target: string | null
    waivable: boolean
  }[]
  review: {
    revision: number
    reason: string
    decision: string
    createdAt: string
  } | null
}
export interface PreparationState {
  revision: number
  stages: StageState[]
}
export interface StageConfirmation {
  revision: number
  requestKey: string
  decision: 'confirmed' | 'skipped'
  reason: string
  acknowledged: boolean
  waived: string[]
  shots: string[]
}
export interface ProposalChange {
  key: string
  label: string
  before: unknown
  after: unknown
  current: unknown
  conflict: boolean
}
export interface ProposalComparison {
  id: string
  baseRevision: number
  revision: number
  state: string
  changes: ProposalChange[]
}
export interface PreparationIntent {
  revision: number
  requestKey: string
  kind: 'reference' | 'storyboard' | 'voice'
  target: string
  configuration?: string
  prompt: string
  voice: string
  text: string
  useReference: boolean
  planHash?: string
}
export interface PreparationPlan {
  plan?: {
    title: string
    kind: string
    model: string
    text: string
    voice: string | null
    references: number
    revision: number
    quotedPoints: number
    estimatedCost: number | null
  }
  planHash?: string
  job?: Job
}
export interface ProposalInput {
  revision: number
  requestKey: string
  document: StudioDocument
}
