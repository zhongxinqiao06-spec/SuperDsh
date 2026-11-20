import type { WorkSummary, WorkMode } from '@/types/studio/works'

export const workModeLabels: Record<WorkMode, string> = {
  quick: '快速视频',
  storyboard: '分镜作品',
  series: '系列短剧',
}
export const workStageLabels: Record<string, string> = {
  script: '故事待确认',
  storyboard: '分镜设计',
  production: '镜头制作',
  timeline: '剪辑与字幕',
  delivery: '成片交付',
}
/** 已有分镜链接保持稳定，系列在整剧内恢复单集上下文。 */
export function workLocation(work: WorkSummary): string {
  if (work.kind === 'series')
    return (
      '/entertainment/series/' +
      encodeURIComponent(work.id) +
      (work.currentEpisodeId && work.hasEpisodeProgress !== false
        ? '?episode=' + encodeURIComponent(work.currentEpisodeId) + '&resume=1'
        : work.episodeCount > 0 && work.deliveredCount === work.episodeCount
          ? '?section=delivery'
          : '?section=episodes')
    )
  return (
    '/entertainment/' +
    (work.kind === 'quick' ? 'quick/' : '') +
    encodeURIComponent(work.id)
  )
}
export function workAction(work: WorkSummary, canEdit: boolean): string {
  if (!canEdit || work.lifecycle === 'archived') return '查看作品'
  if (work.kind === 'series') {
    if (work.episodeCount > 0 && work.deliveredCount === work.episodeCount)
      return '查看成片'
    return work.currentEpisodeNumber && work.hasEpisodeProgress !== false
      ? `继续第 ${work.currentEpisodeNumber} 集`
      : '编排分集'
  }
  if (work.kind === 'quick') return work.coverJobId ? '查看结果' : '继续编辑'
  return '继续制作'
}
