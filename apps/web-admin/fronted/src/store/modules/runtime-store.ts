import { onScopeDispose, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import { runtimeApi, type ServerAgent } from '@/api/workbench/runtime-api'
import { sessionController } from '@/store/session-controller'
import { errorMessage } from '@/utils/errors'

/** 每账号代际只自动准备一次；离开页面不停止已提交任务。 */
export const useRuntimeStore = defineStore('workbench-runtime', () => {
  const agent = shallowRef<ServerAgent | null>(null)
  const error = ref(''),
    busy = ref(false)
  let attempted = false
  let generation = sessionController.generation
  let pending: Promise<void> | null = null
  let refreshRequest = 0
  function syncIdentity(): void {
    if (generation === sessionController.generation) return
    generation = sessionController.generation
    attempted = false
    pending = null
    agent.value = null
    error.value = ''
    busy.value = false
    refreshRequest++
  }
  onScopeDispose(sessionController.subscribe(syncIdentity))
  /** 状态读取允许页面取消，不撤销服务端运行。 */
  async function refresh(signal?: AbortSignal): Promise<void> {
    syncIdentity()
    const started = generation
    const request = ++refreshRequest
    const response = await runtimeApi.get(signal)
    if (started === sessionController.generation && request === refreshRequest)
      agent.value = response.agent
  }
  /** 重试必须由显式操作触发，失败不能循环启动进程。 */
  function prepare(force = false): Promise<void> {
    syncIdentity()
    if (pending) return pending
    if (attempted && !force) return Promise.resolve()
    attempted = true
    busy.value = true
    error.value = ''
    const started = generation
    const task = (async () => {
      await refresh()
      if (started !== sessionController.generation) return
      if (
        agent.value?.status === 'running' ||
        agent.value?.status === 'starting'
      )
        return
      if (!force && (agent.value?.status !== 'stopped' || agent.value.error))
        return
      const response = await runtimeApi.prepare()
      if (started === sessionController.generation) agent.value = response.agent
    })()
      .catch((cause: unknown) => {
        if (started === sessionController.generation)
          error.value = errorMessage(cause)
      })
      .finally(() => {
        if (started === sessionController.generation) {
          busy.value = false
          pending = null
        }
      })
    pending = task
    return task
  }
  return { agent, error, busy, prepare, refresh }
})
