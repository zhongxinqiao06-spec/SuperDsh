/** 启动阶段是产品固定标识；诊断不能携带异常正文、堆栈、环境或凭据。 */
export type StartupStage =
  'host-start' | 'host-ready' | 'bridge-service' | 'bridge-start' | 'host-stop'

const codes = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'EADDRINUSE',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'MODULE_NOT_FOUND',
  'ERR_MODULE_NOT_FOUND',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'ERR_REQUIRE_ESM',
  'ERR_DLOPEN_FAILED',
  'runtime_bridge_missing',
  'runtime_bridge_not_ready',
])

/** 只输出固定错误类别与白名单 code；不读取自定义 name/message 或 getter。 */
export function startupDiagnostic(stage: StartupStage, error: unknown) {
  const name =
    error instanceof TypeError
      ? 'TypeError'
      : error instanceof SyntaxError
        ? 'SyntaxError'
        : error instanceof RangeError
          ? 'RangeError'
          : error instanceof ReferenceError
            ? 'ReferenceError'
            : error instanceof Error
              ? 'Error'
              : 'UnknownError'
  const code =
    error && typeof error === 'object'
      ? Object.getOwnPropertyDescriptor(error, 'code')?.value
      : undefined
  return {
    stage,
    name,
    code: typeof code === 'string' && codes.has(code) ? code : 'unclassified',
  }
}
