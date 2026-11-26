import type { PublishPlan } from './catalog'

/** 草稿修订独立于已售商品修订，归属与快照由服务端保存。 */
export interface PricingVersion<T> {
  id: string
  scope: string
  revision: number
  effectiveAt: string | null
  createdAt: string
  payload: { terms: T; reason?: string }
}
export type PlanDraft = PricingVersion<PublishPlan>
export interface RateTerms {
  product: 'office' | 'entertainment'
  capability: string
  model: string
  modelRevision: number
  spec: string
  payer: 'platform' | 'personal'
  unit: 'second' | 'image' | 'character' | 'call'
  unitSize: number
  unitPoints: number
}
export type RateVersion = PricingVersion<RateTerms>
export type UsageItem = Omit<RateTerms, 'unit' | 'unitSize' | 'unitPoints'> & {
  quantity: number
}
export interface PricedItem extends UsageItem {
  unit: RateTerms['unit']
  unitSize: number
  unitPoints: number
  units: number
  points: number
}
export interface UsageQuote {
  id: string
  source: string
  totalPoints: number
  items: (PricedItem & { rateId: string; rateRevision: number })[]
  expiresAt: string
  lockedAt: string | null
}
export interface TrialResult {
  current: PricedItem | null
  candidate: PricedItem | null
  difference: number | null
}
