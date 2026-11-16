import type { ProjectBrief, StoryScene } from './foundation'
/** ID 始终指向具体素材版本、镜头、台词或生成回执，不使用显示顺序寻址。 */
export interface StudioAsset {
  version?: number
  entityId?: string
  id: string
  sourceJob?: string | null
  parent: string | null
  project: string | null
  family: string
  kind: 'character' | 'scene' | 'prop' | 'image' | 'video' | 'audio' | 'music'
  name: string
  description: string
  voice: string
  fileId: string | null
  voiceBinding?: {
    configurationId: string
    revision: number
    capability: string
  } | null
  voicePreviewJob?: string | null
}
export interface Dialogue {
  id: string
  role: string
  text: string
  voice: string
  subtitle: string | null
  subtitleStart?: number | null
  start: number
  end: number | null
  audio: string | null
  volume: number
}
export interface Shot {
  sceneId?: string | null
  id: string
  action: string
  scene: string
  camera: string
  framing: string
  movement: string
  duration: number
  references: string[]
  lines: Dialogue[]
  candidate: string | null
  trimStart: number
  trimEnd: number | null
}
export interface StudioDocument {
  adaptationMode?: 'original' | 'adapt'
  scenes?: StoryScene[]
  script: string
  assets: string[]
  shots: Shot[]
  music: string | null
  musicVolume: number
}
export interface Project extends Partial<ProjectBrief> {
  lifecycle?: 'active' | 'archived'
  shots?: number
  adopted?: number
  id: string
  title: string
  revision: number
  sessionId: string | null
  updated: string
}
export interface Job {
  id: string
  subject: string
  kind: 'export' | 'video' | 'speech' | 'image'
  revision: number
  state: string
  error: string | null
  duration: number | null
  recoveryState?: string | null
  hasReceipt?: boolean
  purpose?: 'reference' | 'storyboard' | 'voice' | null
  family?: string | null
  sourceVersion?: string | null
  voice?: string | null
  text?: string | null
}
export interface StudioProject extends Project {
  document: StudioDocument
  proposal: { id: string; revision: number; shots: Shot[] } | null
  assets: StudioAsset[]
  jobs: Job[]
  history: { revision: number; label: string }[]
}
/** 跨作品目录只返回展示字段，单个工程仍从工作台接口按需打开。 */
export interface StudioPage<T> {
  total: number
  items: T[]
}
export interface StudioPageQuery {
  page: number
  pageSize: number
  search: string
}
export type ProjectSummary = Pick<
  Project,
  | 'id'
  | 'title'
  | 'revision'
  | 'updated'
  | 'lifecycle'
  | 'aspectWidth'
  | 'aspectHeight'
  | 'targetDurationMs'
> & {
  shots: number
  adopted: number
  /** 当前镜序中第一个可播放的已采用结果，通过作品媒体接口授权。 */
  coverJobId: string | null
}
export interface DirectoryAsset extends StudioAsset {
  workId: string | null
  workTitle: string | null
}
export interface DirectoryJob extends Pick<
  Job,
  | 'id'
  | 'subject'
  | 'kind'
  | 'state'
  | 'revision'
  | 'error'
  | 'recoveryState'
  | 'hasReceipt'
> {
  summary: string | null
  entity?: string | null
  entityKind?: string | null
  project: string | null
  projectTitle: string
  updated: string
}
export interface StudioModel {
  id: string
  name: string
  capability: string
  connectionId: string
  modelId: string
  parameters: { voices?: string; inputMode?: string }
}
export interface StudioCatalog {
  configurations: StudioModel[]
  defaults: { capability: string; configurationId: string }[]
  agents: { id: string; name: string }[]
}
export interface Generation {
  shots: string[]
  lines: string[]
  export?: boolean
  video?: string
  referenceVideo?: string
  speech?: string
}
