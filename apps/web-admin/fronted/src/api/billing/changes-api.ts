import { request } from '@/utils/request'
import type { ChangeCommand, ChangeRecord } from '@/types/billing/changes'

function endpoint(owner: string) {
  return (
    '/admin/billing/subscriptions/' + encodeURIComponent(owner) + '/changes'
  )
}

/** 换档只登记下一未购周期的办理指令，命令携带当前会员修订号。 */
export const changesApi = {
  history: (owner: string, page: number, signal: AbortSignal) =>
    request<{ items: ChangeRecord[]; hasMore: boolean }>(endpoint(owner), {
      query: { page, pageSize: 10 },
      signal,
    }),
  schedule: (owner: string, body: ChangeCommand & { planVersionId: string }) =>
    request<ChangeRecord>(endpoint(owner), { method: 'POST', body }),
  cancel: (owner: string, id: string, body: ChangeCommand) =>
    request<ChangeRecord>(endpoint(owner) + '/' + encodeURIComponent(id), {
      method: 'DELETE',
      body,
    }),
}
