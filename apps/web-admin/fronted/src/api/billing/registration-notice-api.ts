import { request } from '@/utils/request'

/** 已发卡原件和服务端确认，登录设备之间共享同一未读状态。 */
export interface RegistrationNotice {
  id: string
  name: string
  image: string
  points: number
  expiresAt: string
}

export const registrationNoticeApi = {
  unread: (signal: AbortSignal) =>
    request<RegistrationNotice | null>('/me/billing/registration-card-notice', {
      signal,
    }),
  acknowledge: (id: string) =>
    request<void>(
      '/me/billing/registration-card-notice/' +
        encodeURIComponent(id) +
        '/seen',
      { method: 'PUT' },
    ),
}
