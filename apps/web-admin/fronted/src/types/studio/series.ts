import type { ProjectBrief } from './foundation'
import type { StudioAsset } from './studio'

/** 整剧只组织故事、设定与剧集；每集继续引用独立制作工程。 */
export interface SeriesBrief extends ProjectBrief {
  narrativeMode: 'continuous' | 'anthology'
  plannedEpisodes: number
}
export interface EpisodeStory {
  synopsis: string
  opening: string
  development: string
  ending: string
  continuity: string
}
export type StoryField = keyof EpisodeStory
export interface SeriesEpisode {
  id: string
  number: number
  title: string
  projectId: string
  projectRevision: number
  story: EpisodeStory
  targetDurationMs: number
  storyRevision: number
  confirmedStoryRevision: number | null
  locked: boolean
  settingsRevision: number
  stage: string
  shots: number
  adopted: number
  coverJobId: string | null
  coverAssetId: string | null
  deliverable: { jobId: string; revision: number; updated: string } | null
}
export interface StudioSeries extends SeriesBrief {
  id: string
  revision: number
  lifecycle: 'active' | 'archived'
  updated: string
  settingsRevision: number
  settings: StudioAsset[]
  episodes: SeriesEpisode[]
  episodeCount: number
  deliveredCount: number
  currentEpisodeId: string | null
  archivedEpisodes: {
    id: string
    title: string
    projectId: string
    archivedAt: string
    reason: string
  }[]
}
export interface EpisodeInput {
  title: string
  story: EpisodeStory
  targetDurationMs: number
}
export interface SeriesOperation {
  revision: number
  requestKey: string
}
export interface EpisodeSuggestion {
  episodeId: string
  title?: string
  story: EpisodeStory
}
export interface SeriesProposal {
  id: string
  state: 'waiting' | 'ready' | 'applied' | 'discarded'
  base: EpisodeSuggestion[]
  suggestions: EpisodeSuggestion[]
  instruction: string
  projectId: string
  prompt: string
  revision: number
  baseRevision: number
}
export interface EpisodeContext {
  seriesId: string
  seriesTitle: string
  episodeId: string
  episodeTitle: string
  seriesLifecycle: 'active' | 'archived'
  number: number
  seriesRevision: number
  settingsRevision: number
  currentSettingsRevision: number
  archived: boolean
  locked: boolean
  episodes: SeriesEpisode[]
}

/** 拆合方案先冻结源工程与新故事，确认前不改变目录或生成媒体。 */
export interface SeriesStructurePlan {
  id: string
  revision: number
  planHash: string
  state: string
  action: 'split' | 'merge'
  sourceEpisodes: {
    id: string
    title: string
    projectId: string
    projectRevision: number
    shots: number
    mediaCount: number
  }[]
  episodes: EpisodeInput[]
  notice: string
}
