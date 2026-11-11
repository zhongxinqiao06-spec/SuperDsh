/** 移动扫码协议保持既有客户端标识；这是协议常量而非产品发布版本。 */
export const mobileLoginProtocol = {
  type: 'agents-anywhere.mobile-login',
  version: 1,
} as const
export interface MobileGrant {
  loginToken: string
  userId: string
  expiresAt: string
}
export interface MobileStatus {
  status:
    | 'pending_scan'
    | 'pending_web_confirm'
    | 'approved'
    | 'consumed'
    | 'expired'
    | 'rejected'
  deviceName: string | null
  userId: string
  expiresAt: string
}
