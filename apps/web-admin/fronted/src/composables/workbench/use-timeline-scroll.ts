import { nextTick, onScopeDispose, ref, watch, type Ref } from 'vue'

/** 仅在阅读末尾时跟随流式内容；展开历史保持阅读位置，卸载移除尺寸观察。 */
export function useTimelineScroll(
  host: Ref<HTMLElement | null>,
  content: Ref<HTMLElement | null>,
  session: Ref<string>,
) {
  const following = ref(true),
    loadingHistory = ref(false)
  let generation = 0
  const observer = new ResizeObserver(() => {
    if (following.value && !loadingHistory.value) bottom()
  })
  function bottom(): void {
    if (host.value) host.value.scrollTop = host.value.scrollHeight
  }
  function scroll(): void {
    const element = host.value
    if (!element || loadingHistory.value) return
    following.value =
      element.scrollHeight - element.scrollTop - element.clientHeight <= 80
  }
  async function older(load: () => Promise<void>): Promise<void> {
    if (loadingHistory.value || !host.value) return
    const element = host.value,
      started = generation
    const height = element.scrollHeight,
      top = element.scrollTop
    loadingHistory.value = true
    try {
      await load()
      await nextTick()
      if (started === generation) {
        element.scrollTop = top + element.scrollHeight - height
        following.value = false
      }
    } finally {
      if (started === generation) loadingHistory.value = false
    }
  }
  watch(
    [host, content],
    ([container, body]) => {
      observer.disconnect()
      if (container) observer.observe(container)
      if (body) observer.observe(body)
      if (following.value) bottom()
    },
    { flush: 'post' },
  )
  watch(session, () => {
    generation++
    loadingHistory.value = false
    following.value = true
    void nextTick(bottom)
  })
  onScopeDispose(() => {
    generation++
    observer.disconnect()
  })
  return { following, loadingHistory, scroll, older }
}
