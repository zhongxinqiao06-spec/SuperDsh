import { request } from '@/utils/request'
import type { PublishPlan } from '@/types/billing/catalog'
import type {
  PlanDraft,
  RateTerms,
  RateVersion,
  TrialResult,
  UsageItem,
  UsageQuote,
} from '@/types/billing/pricing'
const root = '/admin/billing/'
interface Page<T> {
  items: T[]
  total: number
}
type Filters = {
  search: string
  page: number
  pageSize: number
  state: string
  payer?: string
}
export const pricingApi = {
  plans: (query: Filters, signal: AbortSignal) =>
    request<Page<PlanDraft>>(root + 'plan-versions', { query, signal }),
  savePlan: (sku: string, expectedDraftRevision: number, terms: PublishPlan) =>
    request<PlanDraft>(root + 'plan-versions', {
      method: 'POST',
      body: { sku, expectedDraftRevision, terms },
    }),
  rates: (query: Filters, signal: AbortSignal) =>
    request<Page<RateVersion>>(root + 'rate-versions', { query, signal }),
  saveRate: (
    terms: RateTerms,
    expectedRevision: number,
    businessKey: string,
    reason: string,
  ) =>
    request<RateVersion>(root + 'rate-versions', {
      method: 'POST',
      body: { terms, expectedRevision, businessKey, reason },
    }),
  publish: (
    domain: 'plan' | 'rate',
    id: string,
    revision: number,
    effectiveAt: string | null = null,
  ) =>
    request(
      root + domain + '-versions/' + encodeURIComponent(id) + '/publish',
      { method: 'POST', body: { revision, effectiveAt } },
    ),
  trial: (item: UsageItem, candidate: RateTerms | null, signal: AbortSignal) =>
    request<TrialResult>(root + 'rate-previews', {
      method: 'POST',
      body: { item, candidate },
      signal,
    }),
  quote: (businessKey: string, source: string, items: UsageItem[]) =>
    request<UsageQuote>('/billing/usage-quotes', {
      method: 'POST',
      body: { businessKey, source, items },
    }),
}
