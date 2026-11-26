/** 会员可见的换档摘要，只包含档位、周期和预约状态。 */
export type ChangeState =
  'scheduled' | 'due' | 'booked' | 'effective' | 'cancelled'
export interface ChangeSummary {
  id: string
  fromPlanName: string
  fromPlanSku: string
  toPlanName: string
  toPlanSku: string
  toVersionId: string
  priceFen: number
  points: number
  effectiveAt: string
  state: ChangeState
}

/** 只有运营历史返回办理人、原因与关联办理单。 */
export interface ChangeRecord extends ChangeSummary {
  createdAt: string
  actorId: string
  reason: string
  bookedOperationId: string | null
  cancelledAt: string | null
  cancelledBy: string | null
  cancelReason: string | null
  restoresChangeId: string | null
}

export interface ChangeCommand {
  expectedRevision: number
  businessKey: string
  reason: string
}
