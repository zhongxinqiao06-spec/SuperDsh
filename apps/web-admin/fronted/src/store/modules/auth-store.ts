import { computed, onScopeDispose, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import { sessionController } from '@/store/session-controller'
import { authApi } from '@/api/auth/auth-api'
import { errorMessage } from '@/utils/errors'

/** 界面认证状态；纯传输与并发细节由SessionController持有。 */
export const useAuthStore = defineStore('auth', () => {
  const session = shallowRef(sessionController.current)
  const generation = shallowRef(sessionController.generation)
  const ready = shallowRef(false)
  const error = shallowRef('')
  let hydration: Promise<void> | null = null
  const unsubscribe = sessionController.subscribe(() => {
    session.value = sessionController.current
    generation.value = sessionController.generation
  })
  onScopeDispose(unsubscribe)
  const authenticated = computed(() => Boolean(session.value))
  const can = (permission: string): boolean =>
    session.value?.permissions.includes(permission) ?? false

  /** 首次访问只恢复身份，不查询设备、不准备执行引擎。 */
  function hydrate(): Promise<void> {
    if (ready.value) return Promise.resolve()
    if (hydration) return hydration
    error.value = ''
    hydration = sessionController
      .refresh()
      .then(() => undefined)
      .catch((cause: unknown) => {
        error.value = errorMessage(cause)
      })
      .finally(() => {
        ready.value = true
        hydration = null
      })
    return hydration
  }

  /** 成功后再发布身份；失败不清除当前表单。 */
  async function login(identifier: string, password: string): Promise<void> {
    sessionController.accept(await authApi.login(identifier, password))
    ready.value = true
  }

  /** 权限变化同步通知路由与当前页面。 */
  async function refreshIdentity(signal?: AbortSignal): Promise<void> {
    sessionController.updateIdentity(await authApi.me(signal))
  }

  return {
    session,
    generation,
    authenticated,
    ready,
    error,
    can,
    hydrate,
    login,
    refreshIdentity,
    signOut: () => sessionController.signOut(),
  }
})
