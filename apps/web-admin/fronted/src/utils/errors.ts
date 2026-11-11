/** 对用户保留业务错误，对调用者保留状态与稳定错误码。 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** 不把服务端堆栈或未知对象序列化到页面。 */
export function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError')
    return '请求已取消'
  if (error instanceof Error) return error.message
  return '操作失败，请重试'
}

/** 接受旧 detail 与规范 message 错误形状；校验错误保持可读。 */
export function responseError(payload: unknown, status: number): ApiError {
  const body = payload && typeof payload === 'object' ? payload : {}
  const detail =
    'detail' in body ? body.detail : 'message' in body ? body.message : null
  const code =
    'code' in body && typeof body.code === 'string' ? body.code : undefined
  return new ApiError(
    typeof detail === 'string'
      ? detail
      : status === 422
        ? '输入格式不正确，请检查表单'
        : `请求失败（${status}）`,
    status,
    code,
  )
}
