import type {
  EpisodeInput,
  EpisodeStory,
  SeriesEpisode,
  StoryField,
} from '@/types/studio/series'

/** 故事编辑使用面向读者的分段；字幕和镜头不从展示文本推断。 */
export const storyFields: {
  key: StoryField
  label: string
  placeholder: string
}[] = [
  {
    key: 'synopsis',
    label: '本集要讲什么',
    placeholder: '谁遇到了什么事，最后发生什么变化？',
  },
  { key: 'opening', label: '开场', placeholder: '从什么画面或事件开始？' },
  {
    key: 'development',
    label: '冲突与转折',
    placeholder: '角色做了什么选择，遇到什么阻碍？',
  },
  { key: 'ending', label: '结尾', placeholder: '本集如何收尾，留下什么期待？' },
  {
    key: 'continuity',
    label: '前后集衔接',
    placeholder: '承接哪些已发生的事，哪些伏笔留给后续？',
  },
]
export function emptyStory(): EpisodeStory {
  return {
    synopsis: '',
    opening: '',
    development: '',
    ending: '',
    continuity: '',
  }
}
export function episodeDraft(episode?: SeriesEpisode): EpisodeInput {
  return {
    title: episode?.title ?? '',
    story: { ...(episode?.story ?? emptyStory()) },
    targetDurationMs: episode?.targetDurationMs ?? 45000,
  }
}
export function episodeStage(episode: SeriesEpisode): string {
  if (episode.deliverable) return '已有成片'
  if (episode.confirmedStoryRevision !== episode.storyRevision)
    return '故事待确认'
  if (!episode.shots) return '待规划分镜'
  if (episode.adopted < episode.shots) return '镜头制作中'
  return '待剪辑交付'
}
/** 继续制作恢复已确认故事所在阶段，未确认时回分集审阅。 */
export function episodeDestination(seriesId: string, episode: SeriesEpisode) {
  if (episode.confirmedStoryRevision !== episode.storyRevision)
    return {
      path: '/entertainment/series/' + encodeURIComponent(seriesId),
      query: { section: 'episodes', episode: episode.id },
    }
  return {
    path: '/entertainment/' + encodeURIComponent(episode.projectId),
    query: {
      section: episode.deliverable
        ? 'delivery'
        : episode.shots
          ? 'storyboard'
          : 'script',
    },
  }
}
