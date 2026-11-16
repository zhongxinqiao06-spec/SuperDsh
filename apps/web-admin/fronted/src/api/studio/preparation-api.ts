import { request } from '@/utils/request'
import type {
  PreparationIntent,
  PreparationPlan,
  PreparationStage,
  PreparationState,
  ProposalComparison,
  StageConfirmation,
} from '@/types/studio/preparation'

const path = (id: string) => '/studio/projects/' + encodeURIComponent(id)
/** 页面与实际准备阶段资源逐项对应；媒体预检与付费提交分开。 */
export const preparationApi = {
  state: (id: string, signal?: AbortSignal) =>
    request<PreparationState>(path(id) + '/preparation', { signal }),
  confirm: (id: string, stage: PreparationStage, body: StageConfirmation) =>
    request(path(id) + '/stages/' + stage + '/confirm', {
      method: 'POST',
      body,
    }),
  compare: (id: string, proposal: string, signal?: AbortSignal) =>
    request<ProposalComparison>(
      path(id) + '/proposals/' + encodeURIComponent(proposal),
      { signal },
    ),
  review: (
    id: string,
    proposal: string,
    body: {
      revision: number
      requestKey: string
      selected: string[]
      overrides: string[]
    },
  ) =>
    request(
      path(id) + '/proposals/' + encodeURIComponent(proposal) + '/review',
      { method: 'POST', body },
    ),
  plan: (id: string, body: PreparationIntent, preview: boolean) =>
    request<PreparationPlan>(path(id) + '/preparation/jobs', {
      method: 'POST',
      query: { preview: String(preview) },
      body,
    }),
  adopt: (
    id: string,
    body: { revision: number; requestKey: string; job: string; target: string },
  ) => request(path(id) + '/preparation/adopt', { method: 'POST', body }),
}
