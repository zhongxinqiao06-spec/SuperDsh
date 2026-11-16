import { onScopeDispose, ref } from 'vue'
import type { useRuntimeStore } from '@/store/modules/runtime-store'
import { sessionController } from '@/store/session-controller'
import { ApiError, errorMessage } from '@/utils/errors'

type RuntimeState = Pick<
  ReturnType<typeof useRuntimeStore>,
  'agent' | 'error' | 'prepare' | 'refresh'
>

/** 工作台准备状态同步：只重试只读查询，不自动重复启动或提交模型任务。 */
export function useRuntimeReadiness(
  runtime: RuntimeState,
  ready: () => Promise<void>,
  signal: AbortSignal,
) {
  const stalled = ref(false)
  let timer: ReturnType<typeof setTimeout> | null = null
  let completion: Promise<boolean> | null = null
  let resolveReady: ((ready: boolean) => void) | undefined
  let firstCheck: Promise<void> | undefined
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  let cycle = 0,
    failures = 0,
    deadline = 0,
    disposed = false
  const cancelTimer = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  const valid = (current: number, identity: number) =>
    !disposed &&
    !signal.aborted &&
    current === cycle &&
    identity === sessionController.generation

  function finish(ready: boolean): void {
    cycle++
    cancelTimer()
    clearTimeout(deadlineTimer)
    const settled = resolveReady
    completion = null
    firstCheck = undefined
    resolveReady = undefined
    settled?.(ready)
  }
  function expire(): void {
    stalled.value = true
    runtime.error = '服务端 Agent 准备超过预期时间，请刷新状态查看结果。'
    finish(false)
  }
  function schedule(current: number, identity: number, delay: number): void {
    cancelTimer()
    timer = setTimeout(() => {
      timer = null
      void check(current, identity)
    }, delay)
  }

  async function check(current: number, identity: number): Promise<void> {
    if (!valid(current, identity)) return
    try {
      await runtime.refresh(signal)
      if (!valid(current, identity)) return
      if (runtime.agent?.status === 'starting') {
        failures = 0
        if (Date.now() >= deadline) {
          expire()
        } else {
          runtime.error = ''
          schedule(current, identity, 1200)
        }
        return
      }
      // 就绪后的设备、项目与模型目录也必须同步，失败时继续只读恢复。
      await ready()
      if (!valid(current, identity)) return
      failures = 0
      stalled.value = false
      runtime.error =
        runtime.agent?.status === 'error'
          ? '服务端 Agent 准备失败，请重新准备；仍失败时检查后端运行诊断。'
          : ''
      finish(runtime.agent?.status === 'running')
    } catch (cause) {
      if (!valid(current, identity)) return
      failures++
      const retryable =
        cause instanceof ApiError &&
        (cause.status === 0 || cause.status === 429 || cause.status >= 500) &&
        cause.code !== 'identity_changed'
      if (retryable && failures < 4 && Date.now() < deadline) {
        runtime.error = `${errorMessage(cause)}，正在重新同步服务端 Agent 状态…`
        schedule(current, identity, Math.min(1200 * 2 ** (failures - 1), 5000))
      } else {
        stalled.value = true
        runtime.error = `${errorMessage(cause)}；暂时无法确认运行状态，请点击“刷新状态”重试。`
        finish(false)
      }
    }
  }

  /** 同一准备周期共用第一次查询和最终结果，重复点击不会重设三分钟期限。 */
  function begin(force: boolean) {
    if (completion && firstCheck)
      return { first: firstCheck, ready: completion }
    if (disposed || signal.aborted)
      return { first: Promise.resolve(), ready: Promise.resolve(false) }
    const current = ++cycle,
      identity = sessionController.generation
    failures = 0
    stalled.value = false
    const timeout = 180_000
    deadline = Date.now() + timeout
    deadlineTimer = setTimeout(expire, timeout)
    const ready = new Promise<boolean>((resolve) => {
      resolveReady = resolve
    })
    completion = ready
    const first = Promise.resolve().then(async () => {
      if (!valid(current, identity)) return
      try {
        await runtime.prepare(force)
        await check(current, identity)
      } catch (cause) {
        if (!valid(current, identity)) return
        stalled.value = true
        runtime.error = errorMessage(cause)
        finish(false)
      }
    })
    firstCheck = first
    return { first, ready }
  }
  function prepare(force = false) {
    return begin(force).first
  }
  function prepareForSubmission() {
    return begin(false).ready
  }
  const cancel = () => finish(false)
  signal.addEventListener('abort', cancel, { once: true })

  let identity = sessionController.generation
  const unsubscribe = sessionController.subscribe(() => {
    if (identity === sessionController.generation) return
    identity = sessionController.generation
    finish(false)
    stalled.value = false
  })
  onScopeDispose(() => {
    disposed = true
    signal.removeEventListener('abort', cancel)
    finish(false)
    unsubscribe()
  })
  return { prepare, prepareForSubmission, stalled }
}
