import { request } from '@/utils/request'

/** 分享记录只属于当前会话所有者，撤销后公开访问立即失效。 */
export interface SessionShare {
  id: string
  url: string
  createdAt: string
  revokedAt: string | null
}
export const shareApi = {
  list: (session: string, signal?: AbortSignal) =>
    request<{ items: SessionShare[] }>(
      `/sessions/${encodeURIComponent(session)}/shares`,
      { signal },
    ),
  create: (session: string, itemId?: string) =>
    request<{ share: SessionShare }>(
      `/sessions/${encodeURIComponent(session)}/shares`,
      {
        method: 'POST',
        body: itemId
          ? { scope: 'message', itemIds: [itemId] }
          : { scope: 'session' },
      },
    ),
  revoke: (id: string) =>
    request(`/shares/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}
