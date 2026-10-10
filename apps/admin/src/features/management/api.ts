import { apiClient } from '@/lib/api'
import type { AdminUser, AdminUserListResponse } from '@/features/auth/types'

export type PlatformRole = {
  id: string
  name: string
  description: string
  builtin: boolean
  permissions: string[]
}
export type Permission = { id: string; label: string }
export type RolesResponse = { roles: PlatformRole[]; permissions: Permission[] }
export type DeviceInventory = {
  id: string
  name: string
  userId: string
  username: string
  connectorKind: string
  deviceOs: string
  version: string | null
  status: string
  lastSeenAt: string | null
  blockedAt: string | null
  blockedReason: string | null
}
export type AuditEvent = {
  id: string
  actorId: string | null
  action: string
  targetId: string | null
  createdAt: string
  detail: unknown
}
export type LoginSession = {
  id: string
  clientName: string
  createdAt: string
  lastSeenAt: string
  expiresAt: string
  current: boolean
}

const id = encodeURIComponent
export const managementApi = {
  users: (page: number, search: string) =>
    apiClient.get<AdminUserListResponse>('/admin/users', {
      query: { page, pageSize: 25, search },
    }),
  createUser: (body: {
    username: string
    email?: string
    displayName: string
    password: string
    roles: string[]
  }) => apiClient.post<AdminUser>('/admin/users', body),
  updateUser: (
    userId: string,
    body: { displayName?: string; roles?: string[]; disabled?: boolean },
  ) => apiClient.patch<AdminUser>(`/admin/users/${id(userId)}`, body),
  deleteUser: (userId: string) =>
    apiClient.delete(`/admin/users/${id(userId)}`),
  restoreUser: (userId: string) =>
    apiClient.post(`/admin/users/${id(userId)}/restore`, {}),
  resetUser: (userId: string) =>
    apiClient.post<{ status: string }>(
      `/admin/users/${id(userId)}/password-reset`,
      {},
    ),
  roles: () => apiClient.get<RolesResponse>('/admin/roles'),
  saveRole: (
    roleId: string | null,
    body: { name: string; description: string; permissions: string[] },
  ) =>
    roleId
      ? apiClient.patch<PlatformRole>(`/admin/roles/${id(roleId)}`, body)
      : apiClient.post<PlatformRole>('/admin/roles', body),
  deleteRole: (roleId: string) =>
    apiClient.delete(`/admin/roles/${id(roleId)}`),
  devices: () =>
    apiClient.get<{ devices: DeviceInventory[] }>('/admin/devices'),
  blockDevice: (deviceId: string, reason: string) =>
    apiClient.post(`/admin/devices/${id(deviceId)}/block`, { reason }),
  resumeDevice: (deviceId: string) =>
    apiClient.post(`/admin/devices/${id(deviceId)}/resume`, {}),
  audit: () => apiClient.get<{ events: AuditEvent[] }>('/admin/audit'),
  sessions: () => apiClient.get<{ sessions: LoginSession[] }>('/auth/sessions'),
  revokeSession: (sessionId: string) =>
    apiClient.delete(`/auth/sessions/${id(sessionId)}`),
  revokeAll: () => apiClient.post('/auth/logout-all', {}),
  recoveryCodes: () =>
    apiClient.post<{ codes: string[] }>('/auth/recovery-codes', {}),
  recover: (body: {
    identifier: string
    recoveryCode: string
    newPassword: string
  }) => apiClient.post('/auth/recovery/reset', body, { auth: false }),
  recoveryEmailCode: (email: string) =>
    apiClient.post<{ retryAfter: number }>(
      '/auth/email-code',
      { email, purpose: 'reset' },
      { auth: false },
    ),
  recoverEmail: (body: { email: string; code: string; newPassword: string }) =>
    apiClient.post('/auth/recovery/reset-email', body, { auth: false }),
}
