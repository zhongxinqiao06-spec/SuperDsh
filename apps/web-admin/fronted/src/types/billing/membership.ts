import type { ChangeSummary } from './changes'

/** 当前试行商品版本，金额单位为人民币分，额度单位为整数创作点。 */
export interface Plan {
  id: string
  sku: string
  name: string
  kind: 'membership' | 'addon'
  termUnit: 'month' | 'year'
  priceFen: number
  points: number
}
export interface Catalog {
  cardDenominations?: number[]
  items: Plan[]
  saleOpen: boolean
  samplePointsPerSecond: number
  sampleClipPoints: number | null
}
export interface CreditLot {
  id: string
  sourceKey: string
  granted: number
  availablePoints: number
  held: number
  expiresAt: string
}
/** 同一账号在两个产品下共用的本人账本快照。 */
/** 额度卡由运营逐张发放，占用与用尽的卡都可以查回。 */
export interface CreditCard {
  id: string
  granted: number
  availablePoints: number
  usedPoints: number
  held: number
  issuedAt: string
  expiresAt: string
  status: 'available' | 'held' | 'spent' | 'expired'
}
export interface Wallet {
  cardPoints?: number
  planChange: ChangeSummary | null
  asOf: string
  availablePoints: number
  heldPoints: number
  expiringPoints: number
  expiringDays: number
  subscription: {
    plan: Plan
    startsAt: string
    endsAt: string
    nextGrantAt: string | null
    nextBookedPlan: { name: string; startsAt: string } | null
  } | null
  lots: CreditLot[]
  hasMoreLots: boolean
}
export interface CreditEntry {
  id: string
  kind: string
  availableDelta: number
  heldDelta: number
  createdAt: string
}
export interface EntryDetail extends CreditEntry {
  lotId: string
  sourceKey: string
  granted: number
  expiresAt: string
}
export interface Entries {
  items: CreditEntry[]
  nextCursor: string | null
}
