import { request } from '@/utils/request'
import type { CreditCard, Wallet } from '@/types/billing/membership'
import type {
  BillingAccount,
  BillingOperation,
  OperationInput,
  OperationRecord,
} from '@/types/billing/operations'

/** 后台写入只提交已冻结的办理单号，确认重试复用原号。 */
export const operationsApi = {
  summary: (owner: string, signal: AbortSignal) =>
    request<Wallet>(
      '/admin/billing/accounts/' + encodeURIComponent(owner) + '/summary',
      { signal },
    ),
  accounts: (
    query: Record<string, string | number | undefined>,
    signal: AbortSignal,
  ) =>
    request<{ items: BillingAccount[]; total: number }>(
      '/admin/billing/subscriptions',
      { query, signal },
    ),
  cards: (owner: string, page: number, signal: AbortSignal) =>
    request<{ items: CreditCard[]; hasMore: boolean }>(
      '/admin/billing/accounts/' + encodeURIComponent(owner) + '/cards',
      { query: { page, pageSize: 10 }, signal },
    ),
  history: (owner: string, page: number, signal: AbortSignal) =>
    request<{ items: OperationRecord[]; hasMore: boolean }>(
      '/admin/billing/subscriptions/' +
        encodeURIComponent(owner) +
        '/operations',
      { query: { page, pageSize: 10 }, signal },
    ),
  preview: (body: OperationInput) =>
    request<BillingOperation>('/admin/billing/operation-previews', {
      method: 'POST',
      body,
    }),
  confirm: (preview: BillingOperation) =>
    request<BillingOperation>(
      ['open', 'renew'].includes(preview.quote.action)
        ? '/admin/billing/subscriptions'
        : '/admin/billing/adjustments',
      { method: 'POST', body: { previewId: preview.id } },
    ),
}
