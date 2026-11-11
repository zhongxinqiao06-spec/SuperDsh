import { onMounted, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { sessionController } from '@/store/session-controller'
import { useAuthStore } from '@/store/modules/auth-store'
import { errorMessage } from '@/utils/errors'

/** 页面资源生命周期：新请求取消旧请求，身份代际变化后拒绝旧结果。 */
export function useResource<T>(loader: (signal: AbortSignal) => Promise<T>) {
  const data = shallowRef<T | null>(null)
  const loading = ref(false)
  const error = ref('')
  const auth = useAuthStore()
  let controller: AbortController | null = null
  let alive = true
  async function reload(): Promise<void> {
    controller?.abort()
    const current = new AbortController()
    controller = current
    const generation = sessionController.generation
    loading.value = true
    error.value = ''
    try {
      const result = await loader(current.signal)
      if (
        alive &&
        !current.signal.aborted &&
        generation === sessionController.generation
      )
        data.value = result
    } catch (cause) {
      if (
        alive &&
        !current.signal.aborted &&
        generation === sessionController.generation
      )
        error.value = errorMessage(cause)
    } finally {
      if (alive && controller === current) loading.value = false
    }
  }
  watch(
    () => auth.generation,
    () => {
      controller?.abort()
      data.value = null
      error.value = ''
    },
  )
  onMounted(() => {
    void reload()
  })
  onScopeDispose(() => {
    alive = false
    controller?.abort()
  })
  return { data, loading, error, reload }
}
