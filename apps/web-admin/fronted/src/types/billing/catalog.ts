import type { Plan } from './membership'

/** 后台版本是独立的商品快照，金额单位分，时间带时区。 */
export interface PlanRelease extends Plan {
  revision: number
  listed: boolean
  effectiveAt: string
  publishedAt: string | null
  publishedBy: string | null
  publishReason: string | null
  withdrawnAt: string | null
  withdrawnBy: string | null
  withdrawReason: string | null
}
export interface PlanSeries {
  latest: PlanRelease
  current: PlanRelease | null
  upcoming: PlanRelease | null
}
export interface CatalogCommand {
  businessKey: string
  reason: string
}
export interface PublishPlan extends CatalogCommand {
  expectedRevision: number
  name: string
  kind: Plan['kind']
  termUnit: Plan['termUnit']
  priceFen: number
  points: number
  weeklyPoints?: number | null
  listed: boolean
  effectiveAt: string | null
}
