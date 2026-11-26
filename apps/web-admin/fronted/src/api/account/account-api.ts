import { request } from '@/utils/request'
import type { Identity } from '@/types/auth/auth'

/** 登录会话只用于账号安全，不能替代设备或聊天会话。 */
export interface LoginSession {
  id: string
  clientName: string
  createdAt: string
  expiresAt: string
  current: boolean
  lastSeenAt?: string | null
}
export const accountApi = {
  close: (accountId: string) =>
    request<{ status: 'closed' }>('/auth/me', {
      method: 'DELETE',
      body: { accountId, confirm: true },
    }),
  profile: (displayName: string) =>
    request<Identity>('/auth/me/profile', {
      method: 'PUT',
      body: { displayName },
    }),
  username: (username: string) =>
    request<Identity>('/auth/me/username', {
      method: 'PUT',
      body: { username },
    }),
  avatar: (avatar: string) =>
    request<Identity>('/auth/me/avatar', { method: 'PUT', body: { avatar } }),
  removeAvatar: () =>
    request<Identity>('/auth/me/avatar', { method: 'DELETE' }),
  email: (email: string, code: string) =>
    request<Identity>('/auth/me/email', {
      method: 'PUT',
      body: { email, code },
    }),
  emailCode: (
    email: string,
    purpose: 'bind' | 'register' | 'reset',
    pendingToken = '',
    signal?: AbortSignal,
  ) =>
    request<{ serverTime: string; expiresAt?: string; resendAt?: string }>(
      '/auth/email-code',
      {
        signal,
        method: 'POST',
        auth: purpose === 'bind',
        body: { email, purpose, pendingToken },
      },
    ),
  recoveryCodes: () =>
    request<{ codes: string[] }>('/auth/recovery-codes', { method: 'POST' }),
  logoutAll: () => request<void>('/auth/logout-all', { method: 'POST' }),
  sessions: (
    signal?: AbortSignal,
    query?: { page: number; pageSize: number; search: string },
  ) =>
    request<{ sessions: LoginSession[]; total?: number }>(
      query
        ? '/auth/sessions?' +
            new URLSearchParams({
              page: String(query.page),
              pageSize: String(query.pageSize),
              search: query.search,
            })
        : '/auth/sessions',
      {
        signal,
      },
    ),
  revoke: (id: string) =>
    request<void>(`/auth/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
}
