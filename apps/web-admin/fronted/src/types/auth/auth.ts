/** 浏览器认证契约；令牌仅保存在当前文档内存。 */
export interface Identity {
  userId: string
  username?: string
  email: string | null
  displayName: string
  role: string
  roles: string[]
  permissions: string[]
  authzVersion: number
  disabled?: boolean
  resetRequired?: boolean
  avatar?: string | null
}

/** 登录/刷新结果保持既有字段语义。 */
export interface AuthResponse extends Identity {
  accessToken: string
  tokenType: string
  expiresIn?: number
}

/** 认证能力以服务端配置为准；needsBootstrap 仅表示服务端初始化尚未完成。 */
export interface AuthConfig {
  needsBootstrap: boolean
  registrationOpen: boolean
  oauthEnabled: boolean
  emailVerificationRequired: boolean
  oauthRegistrationOpen?: boolean
  oauthProviderLabel?: string | null
}
