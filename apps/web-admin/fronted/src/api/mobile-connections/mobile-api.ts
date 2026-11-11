import { request } from '@/utils/request'
import type {
  MobileGrant,
  MobileStatus,
} from '@/types/mobile-connections/mobile'
export const mobileApi = {
  create: () =>
    request<MobileGrant>('/auth/mobile-login/qr', { method: 'POST' }),
  status: (loginToken: string, signal?: AbortSignal) =>
    request<MobileStatus>('/auth/mobile-login/status', {
      method: 'POST',
      body: { loginToken },
      signal,
    }),
  confirm: (loginToken: string, approved: boolean) =>
    request<MobileStatus>('/auth/mobile-login/confirm', {
      method: 'POST',
      body: { loginToken, approved },
    }),
}
