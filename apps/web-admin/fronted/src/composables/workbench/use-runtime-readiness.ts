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
          stalled.value = true
          runtime.error = '服务端 Agent 准备超过预期时间，请刷新状态查看结果。'
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
      }
    }
  }

  /** 显式操作重新核对状态；已有 starting/running 实例不会再次发起启动。 */
  async function prepare(force = false): Promise<void> {
    cancelTimer()
    const current = ++cycle,
      identity = sessionController.generation
    failures = 0
    stalled.value = false
    deadline = Date.now() + 180_000
    await runtime.prepare(force)
    await check(current, identity)
  }

  let identity = sessionController.generation
  const unsubscribe = sessionController.subscribe(() => {
    if (identity === sessionController.generation) return
    identity = sessionController.generation
    cycle++
    cancelTimer()
    stalled.value = false
  })
  onScopeDispose(() => {
    disposed = true
    cancelTimer()
    unsubscribe()
  })
  return { prepare, stalled }
}
