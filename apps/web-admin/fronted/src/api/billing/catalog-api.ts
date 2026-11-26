import { request } from '@/utils/request'
import type {
  CatalogCommand,
  PlanRelease,
  PlanSeries,
  PublishPlan,
} from '@/types/billing/catalog'

const path = '/admin/billing/plans'
const versions = (sku: string) =>
  path + '/' + encodeURIComponent(sku) + '/versions'

/** 平台版本目录含已停售与待生效的商品，与会员可见目录分别查询。 */
export const catalogAdminApi = {
  list: (
    search: string,
    page: number,
    pageSize: number,
    signal: AbortSignal,
    exact = false,
  ) =>
    request<{ items: PlanSeries[]; total: number }>(path, {
      query: { search, page, pageSize, exact: String(exact) },
      signal,
    }),
  history: (sku: string, page: number, pageSize: number, signal: AbortSignal) =>
    request<{ items: PlanRelease[]; total: number }>(versions(sku), {
      query: { page, pageSize },
      signal,
    }),
  publish: (sku: string, body: PublishPlan) =>
    request<PlanRelease>(versions(sku), { method: 'POST', body }),
  withdraw: (sku: string, revision: number, body: CatalogCommand) =>
    request<PlanRelease>(versions(sku) + '/' + revision + '/withdraw', {
      method: 'POST',
      body,
    }),
}
