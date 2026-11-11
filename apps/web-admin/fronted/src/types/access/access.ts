/** 用户管理DTO，revision只用于并发控制，不是发布版本。 */
export interface ManagedUser {
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
