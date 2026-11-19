import { computed, onScopeDispose, ref } from 'vue'
import { seriesApi } from '@/api/studio/series-api'
import { useAuthStore } from '@/store/modules/auth-store'
import { createUuid } from '@/utils/uuid'
import type { StudioSeries } from '@/types/studio/series'
import { errorMessage } from '@/utils/errors'

/** 整剧页面唯一写入协调；操作失败保留请求身份，离开页面后丢弃迟到结果。 */
export function useStudioSeries(id: string) {
  const auth = useAuthStore()
  const data = ref<StudioSeries>()
  const loading = ref(false),
    busy = ref(false),
    error = ref('')
  const abort = new AbortController()
  const allowed = computed(
    () =>
      auth.can('studio.projects.write') && data.value?.lifecycle !== 'archived',
  )
  const attempts = new Map<string, string>()
  function operation(payload: unknown) {
    const signature = JSON.stringify([data.value?.revision, payload])
    if (!attempts.has(signature)) attempts.set(signature, createUuid())
    return {
      revision: data.value?.revision ?? 0,
      requestKey: attempts.get(signature)!,
    }
  }
  async function reload() {
    loading.value = true
    error.value = ''
    try {
      const result = await seriesApi.open(id, abort.signal)
      if (!abort.signal.aborted) data.value = result
    } catch (cause) {
      if (!abort.signal.aborted) error.value = errorMessage(cause)
    } finally {
      loading.value = false
    }
  }
  async function commit(action: () => Promise<StudioSeries>) {
    if (busy.value || !allowed.value)
      throw new Error('当前不可修改，请等待操作完成或检查权限')
    busy.value = true
    error.value = ''
    try {
      const result = await action()
      abort.signal.throwIfAborted()
      data.value = result
      attempts.clear()
      return result
    } catch (cause) {
      if (!abort.signal.aborted) error.value = errorMessage(cause)
      throw cause
    } finally {
      busy.value = false
    }
  }
  onScopeDispose(() => abort.abort())
  void reload()
  return { data, loading, busy, error, allowed, operation, reload, commit }
}
