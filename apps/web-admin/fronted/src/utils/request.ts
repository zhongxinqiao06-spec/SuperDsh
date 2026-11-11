import { apiUrl } from '@/utils/api-config'
import { ApiError, responseError } from '@/utils/errors'
import { sessionController } from '@/store/session-controller'

/** 领域API调用选项；取消信号向下传播，默认请求有时间上限。 */
export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  auth?: boolean
  signal?: AbortSignal
  /** 有明确长任务的领域可扩展等待，所有请求仍限制在五分钟内。 */
  timeoutMs?: number
  query?: Record<string, string | number | undefined>
}

/** 同源传输、401单次续期和账号代际校验；不重试未知结果的副作用。 */
export async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const generation = sessionController.generation
  const token = sessionController.current?.accessToken
  // 身份恢复只由认证入口执行；已登出的业务请求不得再次尝试复活Cookie。
  if (options.auth !== false && !token)
    throw new ApiError('请先登录', 401, 'authentication_required')
  const headers = new Headers({
    accept: 'application/json',
    'X-SuperDsh-Agent-Preparation': 'deferred',
  })
  if (options.auth !== false && token)
    headers.set('authorization', `Bearer ${token}`)
  if (options.body !== undefined)
    headers.set('content-type', 'application/json')
  const timeout = Math.max(
    1_000,
    Math.min(options.timeoutMs ?? 20_000, 300_000),
  )
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)])
    : AbortSignal.timeout(timeout)
  const init: RequestInit = {
    method: options.method ?? 'GET',
    headers,
    credentials: 'same-origin',
    signal,
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  }
  const url = apiUrl(path, options.query)
  let response: Response
  try {
    response = await fetch(url, init)
    if (
      response.status === 401 &&
      options.auth !== false &&
      generation === sessionController.generation
    ) {
      const renewed =
        sessionController.current?.accessToken !== token &&
        sessionController.current
          ? sessionController.current
          : await sessionController.refresh()
      if (
        renewed &&
        generation === sessionController.generation &&
        !signal.aborted
      ) {
        headers.set('authorization', `Bearer ${renewed.accessToken}`)
        response = await fetch(url, init)
      }
    }
  } catch (error) {
    if (signal.aborted)
      throw new ApiError(
        options.signal?.aborted ? '请求已取消' : '请求超时，请重试',
        0,
        'request_cancelled',
      )
    if (error instanceof ApiError) throw error
    throw new ApiError(
      '无法连接服务，请检查网络后重试',
      0,
      'network_unavailable',
    )
  }
  if (options.auth !== false && generation !== sessionController.generation) {
    throw new ApiError('账号状态已变化，请重新操作', 0, 'identity_changed')
  }
  if (response.status === 204) return undefined as T
  const content = await response.text()
  let payload: unknown
  try {
    payload = content ? JSON.parse(content) : null
  } catch {
    throw new ApiError('服务返回了无法识别的数据', response.status)
  }
  if (!response.ok) throw responseError(payload, response.status)
  return payload as T
}
