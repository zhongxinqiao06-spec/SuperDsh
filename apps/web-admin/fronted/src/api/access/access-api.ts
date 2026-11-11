import { request } from '@/utils/request'
import { createPasswordVerifier } from '@/utils/auth/password-verifier'
import type {
  ManagedUser,
  PlatformRole,
  RoleDraft,
  RoleList,
  UserDraft,
  UserList,
} from '@/types/access/access'

/** 用户与角色真实服务调用；域内路径不包含发布版本。 */
export const accessApi = {
  users: (
    page: number,
    search: string,
    pageSize: number,
    signal?: AbortSignal,
  ) =>
    request<UserList>('/admin/users', {
      query: { page, search, pageSize },
      signal,
    }),
  async createUser(draft: UserDraft): Promise<ManagedUser> {
    const { password, email, ...profile } = draft
    return request('/admin/users', {
      method: 'POST',
      body: {
        ...profile,
        ...(email.trim() ? { email: email.trim() } : {}),
        ...(await createPasswordVerifier(password)),
      },
    })
  },
  updateUser: (
    user: ManagedUser,
    body: { displayName?: string; roles?: string[]; disabled?: boolean },
  ) =>
    request<ManagedUser>(`/admin/users/${encodeURIComponent(user.userId)}`, {
      method: 'PATCH',
      body: { ...body, revision: user.revision },
    }),
  deleteUser: (user: ManagedUser) =>
    request<void>(`/admin/users/${encodeURIComponent(user.userId)}`, {
      method: 'DELETE',
    }),
  restoreUser: (user: ManagedUser) =>
    request<ManagedUser>(
      `/admin/users/${encodeURIComponent(user.userId)}/restore`,
      { method: 'POST' },
    ),
  requestPasswordRecovery: (user: ManagedUser) =>
    request<{ status: string }>(
      `/admin/users/${encodeURIComponent(user.userId)}/password-reset`,
      { method: 'POST' },
    ),
  roles: (signal?: AbortSignal) =>
    request<RoleList>('/admin/roles', { signal }),
  saveRole: (role: PlatformRole | null, body: RoleDraft) =>
    request<PlatformRole>(
      role ? `/admin/roles/${encodeURIComponent(role.id)}` : '/admin/roles',
      {
        method: role ? 'PATCH' : 'POST',
        body: { ...body, ...(role ? { revision: role.revision } : {}) },
      },
    ),
  deleteRole: (role: PlatformRole) =>
    request<void>(`/admin/roles/${encodeURIComponent(role.id)}`, {
      method: 'DELETE',
    }),
}
