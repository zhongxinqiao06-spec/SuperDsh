import type { Job, StudioAsset } from './studio'

/** 预检结果与已确认任务分开，页面不推断是否需要重新付费。 */
export interface GenerationPlan {
  id: string
  revision: number
  planHash: string
  state: string
  items: {
    target: string
    shot?: string
    kind: string
    label: string
    selected: boolean
    status: string
    message?: string
    model: string
    seconds?: number
    characters?: number
    voice?: string
    references?: number
    job?: string | null
  }[]
  issues: { target: string; message: string }[]
  result?: { jobs: Job[] } | null
}
export interface ProductionIntent {
  revision: number
  requestKey: string
  mode: 'missing' | 'failed' | 'selected' | 'all'
  shots: string[]
  lines: string[]
  video?: string
  referenceVideo?: string
  speech?: string
  allowDuplicate?: boolean
  reason?: string
}
export interface PersonalIntent {
  revision: number
  requestKey: string
  kind: 'reference' | 'voice'
  configuration?: string
  prompt: string
  text: string
  voice: string
  useReference: boolean
  allowDuplicate?: boolean
  reason?: string
}
export interface PersonalProduction {
  revision: number
  asset: StudioAsset
  jobs: Job[]
}
export type JobDecision =
  'cancel' | 'resume' | 'receipt' | 'unaccepted' | 'keep'
