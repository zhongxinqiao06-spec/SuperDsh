import { ref, watch, type WatchSource } from 'vue'
import { useResource } from '@/composables/use-resource'
import type { StudioPage, StudioPageQuery } from '@/types/studio/studio'

/** 搜索和筛选按整库分页；快速切换时由公共资源生命周期丢弃过期响应。 */
export function useStudioDirectory<T>(
  load: (query: StudioPageQuery, signal: AbortSignal) => Promise<StudioPage<T>>,
  filters: WatchSource[] = [],
) {
  const page = ref(1),
    pageSize = ref(10),
    query = ref(''),
    search = ref('')
  const resource = useResource((signal) =>
    load(
      { page: page.value, pageSize: pageSize.value, search: search.value },
      signal,
    ),
  )
  watch(
    [search, ...filters],
    () => {
      page.value = 1
    },
    { flush: 'sync' },
  )
  watch([page, pageSize, search, ...filters], () => void resource.reload())
  watch(
    () => resource.data.value?.total,
    (total) => {
      if (total !== undefined)
        page.value = Math.min(
          page.value,
          Math.max(1, Math.ceil(total / pageSize.value)),
        )
    },
  )
  function filter() {
    const next = query.value.trim()
    if (next === search.value) void resource.reload()
    else search.value = next
  }
  return { page, pageSize, query, search, filter, ...resource }
}
