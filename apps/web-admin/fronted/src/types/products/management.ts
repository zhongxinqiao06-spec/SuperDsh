import type { Capability, ModelConfiguration } from '@/types/models/models'

/** 仅带回本产品成员的公开显示字段和可撤回资格。 */
export interface ProductMember {
  userId: string
  username: string
  displayName: string | null
  roleIds: string[]
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
