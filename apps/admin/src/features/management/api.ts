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
export type ListPagination = {
  total: number
  page: number
  pageSize: number
}
export type DeviceInventoryResponse = ListPagination & {
  devices: DeviceInventory[]
}
export type AuditResponse = ListPagination & { events: AuditEvent[] }
export type LoginSessionsResponse = ListPagination & {
  sessions: LoginSession[]
}

function pageQuery(page?: number, search?: string, pageSize?: number) {
  return { page, search, pageSize }
}

const id = encodeURIComponent
export const managementApi = {
  users: (page: number, search: string, pageSize = 25) =>
    apiClient.get<AdminUserListResponse>('/admin/users', {
      query: pageQuery(page, search, pageSize),
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
  devices: (page?: number, search?: string, pageSize?: number) =>
    apiClient.get<DeviceInventoryResponse>('/admin/devices', {
      query: pageQuery(page, search, pageSize),
    }),
  blockDevice: (deviceId: string, reason: string) =>
    apiClient.post(`/admin/devices/${id(deviceId)}/block`, { reason }),
  resumeDevice: (deviceId: string) =>
    apiClient.post(`/admin/devices/${id(deviceId)}/resume`, {}),
  audit: (page?: number, search?: string, pageSize?: number) =>
    apiClient.get<AuditResponse>('/admin/audit', {
      query: pageQuery(page, search, pageSize),
    }),
  sessions: (page?: number, search?: string, pageSize?: number) =>
    apiClient.get<LoginSessionsResponse>('/auth/sessions', {
      query: pageQuery(page, search, pageSize),
    }),
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
