import { request } from '@/utils/request'
import { apiUrl } from '@/utils/api-config'
import type { Job } from '@/types/studio/studio'
import type {
  GenerationPlan,
  ProductionIntent,
  PersonalIntent,
  PersonalProduction,
  JobDecision,
} from '@/types/studio/production'

const scope = (kind: 'projects' | 'entities', id: string) =>
  '/studio/' + kind + '/' + encodeURIComponent(id)
/** 同一冻结计划重复确认返回同一组任务；媒体文件单独申请限定范围授权。 */
export const productionApi = {
  prepare: (project: string, body: ProductionIntent) =>
    request<GenerationPlan>(scope('projects', project) + '/generation-plans', {
      method: 'POST',
      body,
    }),
  personalPrepare: (entity: string, body: PersonalIntent) =>
    request<GenerationPlan>(scope('entities', entity) + '/generation-plans', {
      method: 'POST',
      body,
    }),
  confirm: (kind: 'projects' | 'entities', id: string, plan: GenerationPlan) =>
    request<{ jobs: Job[] }>(
      scope(kind, id) +
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
      },
    ),
  personal: (entity: string, signal?: AbortSignal) =>
    request<PersonalProduction>(scope('entities', entity) + '/production', {
      signal,
    }),
  adopt: (entity: string, revision: number, job: string, requestKey: string) =>
    request(scope('entities', entity) + '/adopt', {
      method: 'POST',
      body: { revision, job, requestKey },
    }),
  decide: (
    job: Pick<Job, 'id' | 'revision'>,
    action: JobDecision,
    requestKey: string,
    reason = '',
    acknowledged = false,
  ) =>
    request<Job>('/studio/jobs/' + encodeURIComponent(job.id) + '/actions', {
      method: 'POST',
      body: {
        revision: job.revision,
        requestKey,
        action,
        reason,
        acknowledged,
      },
    }),
  history: (job: string) =>
    request<
      {
        kind: string
        detail: { reason: string; remoteStatus?: string }
        created: string
      }[]
    >('/studio/jobs/' + encodeURIComponent(job) + '/actions'),
  personalMedia: async (job: string, signal?: AbortSignal) => {
    const path = '/studio/personal-media/' + encodeURIComponent(job)
    await request(path + '/access', { method: 'POST', signal })
    return apiUrl(path)
  },
}
