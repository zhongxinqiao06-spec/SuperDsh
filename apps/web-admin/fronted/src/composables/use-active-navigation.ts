import { nextTick, onMounted, onScopeDispose, watch, type Ref } from 'vue'

/** 页签变化或容器缩窄时只滚动导航自身，保留正文位置和当前入口可见。 */
export function useActiveNavigation(
  container: Ref<HTMLElement | undefined>,
  active: () => string,
) {
  let observer: ResizeObserver | undefined
  async function reveal() {
    await nextTick()
    const nav = container.value
    const current = nav?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!nav || !current) return
    const bounds = nav.getBoundingClientRect(),
      selected = current.getBoundingClientRect()
    if (selected.left < bounds.left || selected.right > bounds.right)
      nav.scrollLeft +=
        selected.left -
        bounds.left -
        (nav.clientWidth - current.clientWidth) / 2
  }
  function observe() {
    observer?.disconnect()
    if (container.value) observer?.observe(container.value)
    void reveal()
  }
  watch(active, reveal, { immediate: true })
  watch(container, observe, { flush: 'post' })
  onMounted(() => {
    observer = new ResizeObserver(() => void reveal())
    observe()
  })
  onScopeDispose(() => observer?.disconnect())
}
