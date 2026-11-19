import { request } from '@/utils/request'
import type {
  QuickCapabilities,
  QuickDraft,
  QuickProject,
} from '@/types/studio/quick'
import type { GenerationPlan } from '@/types/studio/production'
import type { Job, Project, StudioAsset } from '@/types/studio/studio'
import type { ProjectBrief } from '@/types/studio/foundation'

const path = (id: string) =>
  '/studio/projects/' + encodeURIComponent(id) + '/quick'
/** 草稿、预检和收费提交分离；所有写入使用稳定请求号和当前修订。 */
export const quickApi = {
  capabilities: (signal?: AbortSignal) =>
    request<QuickCapabilities>('/studio/quick-capabilities', { signal }),
  create: (body: ProjectBrief & { requestKey: string }, signal?: AbortSignal) =>
    request<Project>('/studio/projects', {
      method: 'POST',
      body: { ...body, creationMode: 'quick' },
      signal,
    }),
  open: (id: string, signal?: AbortSignal) =>
    request<QuickProject>(path(id), { signal }),
  save: (
    id: string,
    body: {
      revision: number
      requestKey: string
      title: string
      draft: QuickDraft
    },
    signal?: AbortSignal,
  ) =>
    request<
      Pick<QuickProject, 'id' | 'title' | 'revision' | 'creationMode' | 'draft'>
    >(path(id), { method: 'PUT', body, signal }),
  prepare: (
    id: string,
    body: {
      revision: number
      requestKey: string
      regenerate: boolean
      allowDuplicate: boolean
      reason: string
    },
    signal?: AbortSignal,
  ) =>
    request<GenerationPlan>(path(id) + '/generation-plans', {
      method: 'POST',
      body,
      signal,
    }),
  confirm: (id: string, plan: GenerationPlan, signal?: AbortSignal) =>
    request<{ jobs: Job[] }>(
      path(id) +
        '/generation-plans/' +
        encodeURIComponent(plan.id) +
        '/confirm',
      {
        method: 'POST',
        body: {
          revision: plan.revision,
          requestKey: plan.id,
          planHash: plan.planHash,
        },
        signal,
      },
    ),
  promote: (
    id: string,
    body: { revision: number; requestKey: string; jobId: string },
    signal?: AbortSignal,
  ) =>
    request<{ id: string; revision: number; creationMode: 'storyboard' }>(
      path(id) + '/promote',
      { method: 'POST', body, signal },
    ),
  collect: (
    id: string,
    body: { revision: number; requestKey: string; jobId: string; name: string },
    signal?: AbortSignal,
  ) =>
    request<StudioAsset>(path(id) + '/collect', {
      method: 'POST',
      body,
      signal,
    }),
}
