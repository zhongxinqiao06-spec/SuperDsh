import { consoleContinuation } from '@/utils/console/routes'
import { productHome } from '@/utils/studio/products'

/** 原生 OAuth 回调必须匹配产品身份，取消路径也不能重定向到任意地址。 */
export function allowedNativeRedirect(client: string, uri: string): boolean {
  if (['superdsh-desktop', 'agents-anywhere-dsh-plugin'].includes(client)) {
    const match =
      /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/oauth\/callback$/u.exec(uri)
    return !!match && Number(match[1]) >= 1024 && Number(match[1]) <= 65535
  }
  return (
    (client === 'agents-anywhere-mobile' &&
      uri === 'agents-anywhere://oauth/callback') ||
    (client === 'agents-anywhere-desktop' &&
      uri === 'agents-anywhere-desktop://oauth/callback')
  )
}
export function authContinuation(value: unknown): string | null {
  return typeof value === 'string' &&
    /^\/(?:mobile-oauth|desktop-oauth|plugin-oauth|oauth\/authorize)(?:\?|$)/u.test(
      value,
    )
    ? value
    : null
}

/** 密码与第三方登录使用同一站内续接规则；没有合法目的地时按产品资格分流。 */
export function signedInDestination(
  value: unknown,
  permissions?: readonly string[],
): string {
  return (
    authContinuation(value) ??
    consoleContinuation(value, permissions) ??
    productHome(permissions)
  )
}
