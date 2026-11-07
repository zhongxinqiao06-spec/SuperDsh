import type { ModelAdapter } from '@superdsh/core/contracts/platform'
import { ApiError } from '../http/api-router.ts'
import { providerRequest } from './provider-http.ts'

/** Read-only connectivity probe. A missing model-list endpoint proves neither
 * invalid credentials nor working inference. Never probe a different billing
 * endpoint or submit paid generation automatically. */
export async function checkModelConnection(input: {
  adapter: ModelAdapter
  baseUrl: string
  key: string
  allowedOrigins: string
  signal: AbortSignal
}) {
  const headers: Record<string, string> =
    input.adapter === 'anthropic-messages'
      ? { 'x-api-key': input.key, 'anthropic-version': '2023-06-01' }
      : { Authorization: 'Bearer ' + input.key }
  let response
  try {
    response = await providerRequest({
      url: input.baseUrl.replace(/\/+$/, '') + '/models',
      method: 'GET',
      headers,
      personal: true,
      allowedOrigins: input.allowedOrigins,
      signal: input.signal,
    })
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('resolve only to public addresses')
    )
      throw new ApiError(
        422,
        '供应商域名解析为非公网地址，请检查代理的 Fake-IP/DNS 设置。可信服务可由部署管理员在 SUPERDSH_PERSONAL_MODEL_ALLOWED_ORIGINS 中仅加入该服务 origin；不要关闭地址校验。',
        { code: 'provider_address_blocked' },
      )
    throw error
  }
  try {
    const status = response.statusCode ?? 502
    if (status === 404 || status === 405)
      return {
        ok: false,
        verification: 'requires-trial',
        upstreamStatus: status,
        note: '供应商未提供兼容的只读 /models 接口（Agent Plan 会出现此情况），这不代表 Key 无效。请用已开通的模型在会话中试运行；本次没有发起收费请求。',
      }
    if (status === 401)
      throw new ApiError(
        502,
        '供应商鉴权未通过（HTTP 401）。' +
          (input.adapter === 'volcengine-ark'
            ? '普通方舟按量 API 使用 /api/v3，Agent Plan 专属 Key 使用 /api/plan/v3，两者不能混用；Bearer 鉴权格式相同。'
            : '请核对该供应商的 API 地址与凭据。'),
        { code: 'provider_authentication_failed' },
      )
    if (status === 403)
      throw new ApiError(
        502,
        '供应商拒绝访问（HTTP 403），请检查项目权限、模型开通及套餐状态。',
        { code: 'provider_access_denied' },
      )
    if (status < 200 || status >= 300)
      throw new ApiError(
        502,
        `供应商连接检查失败（HTTP ${status}），未发起生成或自动重试。`,
        { code: 'provider_check_failed' },
      )
    return {
      ok: true,
      verification: 'model-list',
      upstreamStatus: status,
      note: '模型列表接口可访问；未发起收费生成，所选模型及能力仍需试运行验证。',
    }
  } finally {
    response.destroy()
  }
}
