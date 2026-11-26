import type { ProjectBrief, StoryScene } from './foundation'
/** ID 始终指向具体素材版本、镜头、台词或生成回执，不使用显示顺序寻址。 */
export interface StudioAsset {
  variantId?: string | null
  variantName?: string | null
  origin?: {
    family: string
    versionId: string
    currentVersionId: string
    /** 按字段基线判断剩余更新，部分采用后不能仅比较版本 ID。 */
    hasUpdates?: boolean
    name: string
  } | null
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
  voicePreviewAssetId?: string | null
  durationMs?: number | null
}
export interface Dialogue {
  /** 库内配音与生成任务互斥，保存时由后端校验实际文件归属。 */
  audioAssetId?: string | null
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
  /** 空值继承所属场次的场景；镜头覆盖不会改动其他镜头。 */
  sceneAssetId?: string | null
  videoAssetId?: string | null
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
  soundEffects?: {
    id: string
    assetId: string
    shotId: string | null
    start: number
    volume: number
    trimStart: number
    trimEnd: number | null
  }[]
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
  usageQuoteId?: string | null
  quotedPoints?: number | null
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
  /** 采用库内画面时用素材版本封面，始终走当前作品授权。 */
  coverAssetId?: string | null
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
