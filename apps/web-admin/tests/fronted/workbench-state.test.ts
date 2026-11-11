import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope, nextTick, ref } from 'vue'
import { useTerminalStore } from '@/store/modules/terminal-store'
import { useTimelineScroll } from '@/composables/workbench/use-timeline-scroll'

beforeEach(() => setActivePinia(createPinia()))

describe('工作台阅读位置和终端标签状态', () => {
  it('同账号重进恢复所选标签，关闭或换号不会复用旧选择', () => {
    const tabs = useTerminalStore()
    tabs.bind(1)
    tabs.select('connector', 'second')
    tabs.bind(1)
    expect(tabs.restore('connector', ['first', 'second'])).toBe('second')
    expect(tabs.restore('other', ['other-first'])).toBe('other-first')
    tabs.forget('connector', 'first')
    expect(tabs.restore('connector', ['first', 'second'])).toBe('second')
    tabs.forget('connector', 'second')
    expect(tabs.restore('connector', ['first', 'second'])).toBe('first')
    tabs.select('connector', 'second')
    tabs.bind(2)
    expect(tabs.restore('connector', ['first', 'second'])).toBe('first')
  })
  it('跟随新内容时滚到底部，向上阅读和展开历史保持位置，卸载清理观察器', async () => {
    let changed!: () => void
    const disconnect = vi.fn(),
      observe = vi.fn()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          changed = callback
        }
        observe = observe
        disconnect = disconnect
      },
    )
    const host = ref<HTMLElement | null>(null),
      content = ref<HTMLElement | null>(null),
      session = ref('one')
    const scope = effectScope()
    const scroll = scope.run(() => useTimelineScroll(host, content, session))!
    const element = document.createElement('div')
    let height = 1000
    Object.defineProperty(element, 'scrollHeight', { get: () => height })
    Object.defineProperty(element, 'clientHeight', { value: 100 })
    host.value = element
    content.value = document.createElement('div')
    await nextTick()
    expect(observe).toHaveBeenCalledTimes(2)
    height = 1100
    changed()
    expect(element.scrollTop).toBe(1100)
    element.scrollTop = 300
    scroll.scroll()
    height = 1200
    changed()
    expect(element.scrollTop).toBe(300)
    await scroll.older(async () => {
      height = 1400
      changed()
    })
    expect(element.scrollTop).toBe(500)
    expect(scroll.following.value).toBe(false)
    session.value = 'two'
    await nextTick()
    await nextTick()
    expect(element.scrollTop).toBe(1400)
    expect(scroll.following.value).toBe(true)
    scope.stop()
    expect(disconnect).toHaveBeenCalledTimes(2)
  })
})
