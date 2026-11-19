import { request } from '@/utils/request'
import type { StudioPage, StudioPageQuery } from '@/types/studio/studio'
import type { WorkMode, WorkSummary } from '@/types/studio/works'

/** 目录过滤、排序和分页由后端统一处理，前端不拼接三份第一页。 */
export const worksApi = {
  page: (
    query: StudioPageQuery & { mode: WorkMode | 'all'; lifecycle: string },
    signal: AbortSignal,
  ) =>
    request<StudioPage<WorkSummary>>('/studio/works', {
      query: { ...query },
      signal,
    }),
  archive: (work: WorkSummary, archived: boolean, requestKey: string) =>
    request(
      '/studio/' +
        (work.kind === 'series' ? 'series' : 'projects') +
        '/' +
        encodeURIComponent(work.id) +
        '/archive',
      {
        method: 'POST',
        body: { revision: work.revision, requestKey, archived },
      },
    ),
}
