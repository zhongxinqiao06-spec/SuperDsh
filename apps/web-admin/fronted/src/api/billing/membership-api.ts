import { request } from '@/utils/request'
import type {
  Catalog,
  CreditCard,
  Entries,
  EntryDetail,
  Wallet,
} from '@/types/billing/membership'

/** 所有归属由访问令牌确定，两个控制台共用同一组只读端点。 */
export const membershipApi = {
  wallet: (signal: AbortSignal) => request<Wallet>('/me/billing', { signal }),
  catalog: (signal: AbortSignal) =>
    request<Catalog>('/billing/catalog', { signal }),
  cards: (page: number, signal: AbortSignal) =>
    request<{ items: CreditCard[]; hasMore: boolean }>('/me/billing/cards', {
      signal,
      query: { page, pageSize: 10 },
    }),
  entries: (
    cursor: string | null,
    kind: string,
    since: string,
    signal: AbortSignal,
  ) => {
    return request<Entries>('/me/billing/entries', {
      signal,
      query: {
        limit: 20,
        cursor: cursor ?? undefined,
        kind: kind || undefined,
        since: since || undefined,
      },
    })
  },
  detail: (id: string, signal: AbortSignal) =>
    request<EntryDetail>('/me/billing/entries/' + encodeURIComponent(id), {
      signal,
    }),
}
