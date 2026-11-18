import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

/** 原生滚动吸附；不拦截滚轮，翻页快捷键只在展示区域生效。 */
export function useShowcaseScroll(viewport: Ref<HTMLElement | undefined>) {
  const active = ref(0)
  let frame = 0
  let observer: ResizeObserver | undefined
  const pages = () => [
    ...(viewport.value?.querySelectorAll<HTMLElement>('[data-chapter]') ?? []),
  ]
  function sync() {
    const root = viewport.value
    if (!root) return
    const line = root.getBoundingClientRect().top + root.clientHeight * 0.35
    const found = pages().findIndex((page) => {
      const rect = page.getBoundingClientRect()
      return rect.top <= line && rect.bottom > line
    })
    if (found >= 0) active.value = found
  }
  function onScroll() {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(sync)
  }
  function jump(id: string) {
    const root = viewport.value
    const page = pages().find((item) => item.id === id)
    if (!root || !page) return
    root.scrollTo({
      top:
        page.getBoundingClientRect().top -
        root.getBoundingClientRect().top +
        root.scrollTop,
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
    })
    page.focus({ preventScroll: true })
  }
  function onKeydown(event: KeyboardEvent) {
    if (
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      (event.target as HTMLElement).closest(
        'a,button,input,textarea,select,[contenteditable]',
      )
    )
      return
    const entries = pages()
    const positions: Record<string, number> = {
      PageDown: Math.min(active.value + 1, entries.length - 1),
      PageUp: Math.max(active.value - 1, 0),
      Home: 0,
      End: entries.length - 1,
    }
    const index = positions[event.key]
    if (index === undefined || !entries[index]) return
    event.preventDefault()
    jump(entries[index].id)
  }
  onMounted(() => {
    viewport.value?.addEventListener('scroll', onScroll, { passive: true })
    observer = new ResizeObserver(onScroll)
    if (viewport.value) observer.observe(viewport.value)
    sync()
  })
  onBeforeUnmount(() => {
    viewport.value?.removeEventListener('scroll', onScroll)
    observer?.disconnect()
    cancelAnimationFrame(frame)
  })
  return { active, jump, onKeydown }
}
