import type { Job, StudioAsset } from './studio'

/** 快速作品只生成一条视频，输入能力由后端已配置模型声明。 */
export type QuickInputMode = 'text' | 'reference' | 'image'
export interface QuickDraft {
  prompt: string
  inputMode: QuickInputMode
  configurationId: string | null
  durationSeconds: number
  aspect: string
  resolution: string
  references: string[]
}
export interface QuickModel {
  id: string
  name: string
  inputModes: QuickInputMode[]
  durations: number[]
  aspects: string[]
  resolutions: string[]
  maxReferences: number
}
export interface QuickCapabilities {
  models: QuickModel[]
  defaultConfigurationId: string | null
}
export interface QuickJob extends Job {
  /** 后端冻结的创建顺序，不随任务状态轮询改变编号。 */
  candidateNumber?: number | null
  quickDraft?: QuickDraft | null
}
export interface QuickProject {
  id: string
  title: string
  revision: number
  creationMode: 'quick' | 'storyboard'
  lifecycle: 'active' | 'archived'
  draft: QuickDraft
  jobs: QuickJob[]
  assets: StudioAsset[]
  capabilities: QuickCapabilities
}
