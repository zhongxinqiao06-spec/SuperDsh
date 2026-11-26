import type { ChangeSummary } from './changes'

/** 管理端查看账号摘要与服务端冻结的办理试算。 */
export type BillingAction =
  'open' | 'renew' | 'gift' | 'compensation' | 'topup' | 'card'
export type PaymentMode = 'complimentary' | 'offline'
export interface BillingAccount {
  unlimited?: boolean
  revision: number
  lastBookedSku: string | null
  lastBookedName: string | null
  planChange: ChangeSummary | null
  userId: string
  username: string
  displayName: string | null
  disabled: boolean
  planId: string | null
  planSku: string | null
  planName: string | null
  endsAt: string | null
  state: 'active' | 'expired' | 'none'
  availablePoints: number
}
export interface OperationInput {
  action: BillingAction
  userId: string
  businessKey: string
  reason: string
  payment: PaymentMode
  planVersionId?: string
  points?: number
  validDays?: number
  receipt?: string
  receivedFen?: number
}
export interface BillingOperation {
  id: string
  userId: string
  expiresAt: string
  confirmedAt: string | null
  quote: {
    action: BillingAction
    username: string
    planName: string | null
    planChangeId: string | null
    priceFen: number
    receivedFen: number
    points: number
    immediatePoints: number
    availableBefore: number
    availableAfter: number
    startsAt: string
    endsAt: string
    previousEnd: string | null
  }
}
export interface OperationRecord extends BillingOperation {
  receipt: string | null
  actorId: string
  reason: string
  payment: PaymentMode
}
