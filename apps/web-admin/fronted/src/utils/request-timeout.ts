/** HTTP 请求默认等待两分钟，长任务可显式延长至五分钟；页面取消始终立即生效。 */
export function requestSignal(
  cancellation?: AbortSignal,
  timeoutMs = 120_000,
): AbortSignal {
  const timeout = AbortSignal.timeout(
    Math.max(1_000, Math.min(timeoutMs, 300_000)),
  )
  return cancellation ? AbortSignal.any([cancellation, timeout]) : timeout
}
