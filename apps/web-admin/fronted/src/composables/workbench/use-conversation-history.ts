import { ref, watch } from 'vue'
import { useResource } from '@/composables/use-resource'
import { conversationApi } from '@/api/workbench/conversation-api'

/** 历史页沿用本人会话游标契约，仅打开会话详情时才进入运行工作台。 */
export function useConversationHistory() {
  const query = ref(''),
    search = ref(''),
    archived = ref(false),
    limit = ref(20)
  const cursors = ref<(string | undefined)[]>([undefined]),
    index = ref(0)
  const resource = useResource((signal) =>
    conversationApi.sessions(
      {
        product: 'office',
        q: search.value || undefined,
        archived: String(archived.value),
        limit: String(limit.value),
        cursor: cursors.value[index.value],
      },
      signal,
    ),
  )
  watch(
    [archived, search, limit],
    () => {
      index.value = 0
      cursors.value = [undefined]
    },
    { flush: 'sync' },
  )
  watch([index, archived, search, limit], () => {
    resource.data.value = null
    void resource.reload()
  })
  function filter() {
    if (search.value === query.value.trim()) void resource.reload()
    else search.value = query.value.trim()
  }
  function next() {
    const cursor = resource.data.value?.nextCursor
    if (resource.loading.value || !cursor) return
    cursors.value[index.value + 1] = cursor
    index.value++
  }
  return { query, archived, limit, index, resource, filter, next }
}
