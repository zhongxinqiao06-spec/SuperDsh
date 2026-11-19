import { request } from '@/utils/request'
import type {
  EpisodeContext,
  EpisodeInput,
  SeriesBrief,
  SeriesOperation,
  SeriesProposal,
  StoryField,
  StudioSeries,
  SeriesStructurePlan,
} from '@/types/studio/series'

const path = (id: string) => '/studio/series/' + encodeURIComponent(id)
const episode = (id: string, target: string) =>
  path(id) + '/episodes/' + encodeURIComponent(target)

/** 整剧写入统一携带修订与稳定操作号，所有素材和单集由服务端复核归属。 */
export const seriesApi = {
  importEpisode: (
    id: string,
    body: SeriesOperation & { projectId: string; projectRevision: number },
  ) =>
    request<StudioSeries>(path(id) + '/import-episode', {
      method: 'POST',
      body,
    }),
  removeEpisode: (
    id: string,
    target: string,
    body: SeriesOperation & { projectRevision: number },
  ) =>
    request<StudioSeries>(episode(id, target) + '/remove', {
      method: 'POST',
      body,
    }),
  structurePlan: (
    id: string,
    body: SeriesOperation & {
      action: 'split' | 'merge'
      episodeIds: string[]
      episodes: EpisodeInput[]
    },
  ) =>
    request<SeriesStructurePlan>(path(id) + '/structure-plans', {
      method: 'POST',
      body,
    }),
  confirmStructure: (
    id: string,
    plan: string,
    body: SeriesOperation & { planHash: string },
  ) =>
    request<StudioSeries>(
      path(id) + '/structure-plans/' + encodeURIComponent(plan) + '/confirm',
      { method: 'POST', body },
    ),
  open: (id: string, signal?: AbortSignal) =>
    request<StudioSeries>(path(id), { signal }),
  create: (
    body: SeriesBrief & { requestKey: string; createEpisodeDrafts?: boolean },
  ) => request<StudioSeries>('/studio/series', { method: 'POST', body }),
  update: (id: string, body: SeriesBrief & SeriesOperation) =>
    request<StudioSeries>(path(id), { method: 'PATCH', body }),
  addEpisode: (id: string, body: EpisodeInput & SeriesOperation) =>
    request<StudioSeries>(path(id) + '/episodes', { method: 'POST', body }),
  saveEpisode: (
    id: string,
    target: string,
    body: EpisodeInput & SeriesOperation,
  ) => request<StudioSeries>(episode(id, target), { method: 'PATCH', body }),
  confirmEpisode: (
    id: string,
    target: string,
    body: SeriesOperation & { projectRevision: number },
  ) =>
    request<StudioSeries>(episode(id, target) + '/confirm', {
      method: 'POST',
      body,
    }),
  lockEpisode: (
    id: string,
    target: string,
    body: SeriesOperation & { locked: boolean },
  ) =>
    request<StudioSeries>(episode(id, target) + '/lock', {
      method: 'POST',
      body,
    }),
  reorder: (id: string, body: SeriesOperation & { episodeIds: string[] }) =>
    request<StudioSeries>(path(id) + '/order', { method: 'PUT', body }),
  settings: (
    id: string,
    body: SeriesOperation & { assetVersionIds: string[] },
  ) => request<StudioSeries>(path(id) + '/settings', { method: 'PUT', body }),
  applySettings: (
    id: string,
    body: SeriesOperation & {
      episodeIds: string[]
      projectRevisions: Record<string, number>
    },
  ) =>
    request<StudioSeries>(path(id) + '/settings/apply', {
      method: 'POST',
      body,
    }),
  context: (project: string, signal?: AbortSignal) =>
    request<EpisodeContext | null>(
      '/studio/projects/' + encodeURIComponent(project) + '/episode-context',
      { signal },
    ),
  proposals: (id: string, signal?: AbortSignal) =>
    request<SeriesProposal[]>(path(id) + '/proposals', { signal }),
  propose: (
    id: string,
    body: SeriesOperation & { episodeIds: string[]; instruction: string },
  ) =>
    request<SeriesProposal>(path(id) + '/proposals', { method: 'POST', body }),
  resolve: (
    id: string,
    proposal: string,
    body: SeriesOperation & {
      action: 'apply' | 'discard'
      selected: { episodeId: string; fields: StoryField[] }[]
    },
  ) =>
    request<StudioSeries>(
      path(id) + '/proposals/' + encodeURIComponent(proposal) + '/resolve',
      {
        method: 'POST',
        body,
      },
    ),
}
