import { onScopeDispose, ref } from 'vue'
import { errorMessage } from '@/utils/errors'
import { sessionController } from '@/store/session-controller'

/** 写操作不自动重发；失败保留表单，离开或换号后不写回旧页面。 */
export function useMutation() {
  const busy = ref(false)
  const error = ref('')
  let alive = true
  onScopeDispose(() => {
    alive = false
  })
  async function run(operation: () => Promise<unknown>): Promise<boolean> {
    if (busy.value) return false
    const generation = sessionController.generation
    busy.value = true
    error.value = ''
    try {
      await operation()
      return alive && generation === sessionController.generation
    } catch (cause) {
      if (alive && generation === sessionController.generation)
        error.value = errorMessage(cause)
      return false
    } finally {
      if (alive) busy.value = false
    }
  }
  return { busy, error, run }
}
