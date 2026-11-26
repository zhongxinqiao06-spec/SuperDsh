import type { BillingAccount } from '@/types/billing/operations'

/** 用户管理DTO，只有具备账务查看权限时才附带会员摘要。 */
export interface ManagedUser {
  billing?: BillingAccount | null
  userId: string
  username?: string
  displayName: string
  email: string | null
  roles: string[]
  role: string
  disabled: boolean
  resetRequired?: boolean
  deletedAt?: string | null
  revision?: number
}
/** 恢复是撤销软删除，不恢复旧登录；重置仅要求本人更改密码。 */
export type UserAction = 'delete' | 'disable' | 'activate' | 'restore' | 'reset'
export interface UserList {
  users: ManagedUser[]
  total: number
  page: number
  pageSize: number
}
export interface PlatformRole {
  id: string
  name: string
  description: string
  permissions: string[]
  builtin: boolean
  revision?: number
}
export interface Permission {
  id: string
  label: string
}
export interface RoleList {
  roles: PlatformRole[]
  permissions: Permission[]
}
export interface UserDraft {
  username: string
  email: string
  displayName: string
  password: string
  roles: string[]
}
export interface RoleDraft {
  name: string
  description: string
  permissions: string[]
}
