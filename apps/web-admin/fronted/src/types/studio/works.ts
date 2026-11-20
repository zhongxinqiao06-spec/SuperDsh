/** 三种作品共用服务端分页，系列子集不重复出现在顶层目录。 */
export type WorkMode = 'quick' | 'storyboard' | 'series'
export interface WorkSummary {
  kind: WorkMode
  id: string
  title: string
  revision: number
  updated: string
  lifecycle: 'active' | 'archived'
  coverProjectId: string | null
  coverJobId: string | null
  coverAssetId: string | null
  shots: number
  adopted: number
  targetDurationMs: number | null
  aspectWidth: number | null
  aspectHeight: number | null
  episodeCount: number
  deliveredCount: number
  /** 系列是否已有分集内容或制作进度，兼容省略此字段的旧摘要。 */
  hasEpisodeProgress?: boolean
  currentEpisodeId: string | null
  currentEpisodeNumber: number | null
  currentStage: string | null
}
