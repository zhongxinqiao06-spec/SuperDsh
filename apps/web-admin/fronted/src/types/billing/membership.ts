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
  weeklyPoints?: number | null
}
/** 管理员维护的卡种，与用户已经领取的独立卡片分开。 */
export interface CardTypeInput {
  name: string
  points: number
  validDays: number
  image: string
  enabled: boolean
  revision: number
}
export interface CardType extends CardTypeInput {
  id: string
}
export interface Catalog {
  cardTypes?: CardType[]
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
/** 每张卡保留发放时的卡面和面额，占用或用尽后仍然可以查询。 */
export interface CreditCard {
  id: string
  name?: string | null
  image?: string | null
  granted: number
  availablePoints: number
  usedPoints: number
  held: number
  issuedAt: string
  expiresAt: string
  status: 'available' | 'held' | 'spent' | 'expired'
}
export interface Wallet {
  ordinaryPoints?: number
  quota?: {
    weeklyLimit: number
    weeklyRemaining: number
    monthlyLimit: number
    monthlyRemaining: number
    weekEndsAt: string
    monthEndsAt: string
  } | null
  unlimited?: boolean
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
