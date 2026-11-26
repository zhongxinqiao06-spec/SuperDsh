import type { Capability, ModelConfiguration } from '@/types/models/models'

import type { BillingAccount } from '@/types/billing/operations'

/** 账务摘要仅对具有跨账号账务读取权限的管理员返回。 */
export interface ProductMember {
  userId: string
  username: string
  displayName: string | null
  roleIds: string[]
  billing?: BillingAccount | null
  removable: boolean
  revision: number
}
export interface MemberPage {
  items: ProductMember[]
  total: number
  page: number
  pageSize: number
}
/** 模型池由平台审批，产品侧选项只需要模型身份与能力。 */
export interface ProductDefaults {
  configurations: Pick<
    ModelConfiguration,
    'id' | 'name' | 'modelId' | 'capability'
  >[]
  defaults: { capability: Capability; configurationId: string | null }[]
  overrides: Partial<Record<Capability, string>>
}
