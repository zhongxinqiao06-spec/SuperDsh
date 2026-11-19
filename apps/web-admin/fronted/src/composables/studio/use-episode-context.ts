import { computed, onScopeDispose, ref } from 'vue'
import { seriesApi } from '@/api/studio/series-api'
import type { EpisodeContext } from '@/types/studio/series'

/** 单集上下文只读加载；失败时禁止以缺少归属信息为由放开编辑。 */
export function useEpisodeContext(project: string) {
  const context = ref<EpisodeContext | null>(null),
    loading = ref(true),
    error = ref('')
  const abort = new AbortController()
  async function reload() {
    loading.value = true
    error.value = ''
    try {
      const result = await seriesApi.context(project, abort.signal)
      if (!abort.signal.aborted) context.value = result
    } catch (cause) {
      if (!abort.signal.aborted) error.value = String(cause)
    } finally {
      if (!abort.signal.aborted) loading.value = false
    }
  }
  const locked = computed(
    () =>
      loading.value ||
      !!error.value ||
      !!context.value?.locked ||
      !!context.value?.archived,
  )
  onScopeDispose(() => abort.abort())
  void reload()
  return { context, loading, error, locked, reload }
}
