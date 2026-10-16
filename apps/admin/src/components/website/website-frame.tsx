'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import styles from './website.module.css'

const sections = [
  { id: 'top', name: '首页', tone: 'dark' },
  { id: 'capabilities', name: '产品能力', tone: 'light' },
  { id: 'scenarios', name: '应用场景', tone: 'light' },
  { id: 'workflow', name: '使用流程', tone: 'light' },
  { id: 'architecture', name: '平台架构', tone: 'dark' },
  { id: 'connected', name: '多端体验', tone: 'light' },
  { id: 'faq', name: '常见问题', tone: 'light' },
  { id: 'start', name: '开始使用', tone: 'dark' },
]

export function WebsiteFrame({ children }: { children: ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(0)

  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    const pages = [
      ...root.querySelectorAll<HTMLElement>('[data-website-section]'),
    ]
    let frame = 0
    let wheelIdle: ReturnType<typeof setTimeout> | undefined
    let gestureHandled = false
    let wheelDistance = 0
    let wheelDirection = 0
    let transitionUntil = 0
    const desktopPaging = window.matchMedia(
      '(min-width: 801px) and (min-height: 601px)',
    )
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        (document.activeElement !== document.body &&
          document.activeElement !== root)
      )
        return
      const pageHeight =
        root.clientHeight -
        parseFloat(
          getComputedStyle(root).getPropertyValue('--website-header-height'),
        )
      const targets: Record<string, number> = {
        PageDown: root.scrollTop + pageHeight,
        PageUp: root.scrollTop - pageHeight,
        Home: 0,
        End: root.scrollHeight,
        ' ': root.scrollTop + pageHeight * (event.shiftKey ? -1 : 1),
      }
      const target = targets[event.key]
      if (target === undefined) return
      event.preventDefault()
      root.scrollTo({
        top: target,
        behavior: reducedMotion.matches ? 'instant' : 'smooth',
      })
    }
    const onWheel = (event: WheelEvent) => {
      if (
        !desktopPaging.matches ||
        event.ctrlKey ||
        Math.abs(event.deltaX) > Math.abs(event.deltaY) ||
        !event.deltaY ||
        (event.target instanceof Element &&
          event.target.closest(
            'input, textarea, select, [contenteditable="true"], dialog, [role="dialog"]',
          ))
      ) {
        return
      }
      clearTimeout(wheelIdle)
      wheelIdle = setTimeout(() => {
        gestureHandled = false
        wheelDistance = 0
      }, 180)
      if (gestureHandled || performance.now() < transitionUntil) {
        event.preventDefault()
        return
      }

      const headerHeight = parseFloat(
        getComputedStyle(root).getPropertyValue('--website-header-height'),
      )
      const availableHeight = root.clientHeight - headerHeight
      const rootTop = root.getBoundingClientRect().top
      const positions = pages.map((page) => ({
        top:
          page.getBoundingClientRect().top -
          rootTop +
          root.scrollTop -
          headerHeight,
        height: page.getBoundingClientRect().height,
      }))
      let current = 0
      positions.forEach((page, index) => {
        if (page.top <= root.scrollTop + 2) current = index
      })
      const direction = Math.sign(event.deltaY)
      const delta =
        event.deltaY *
        (event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? availableHeight
            : 1)
      const page = positions[current]
      if (!page) return
      const bottom = page.top + page.height - availableHeight
      const withinTallPage =
        direction > 0
          ? root.scrollTop < bottom - 2
          : root.scrollTop > page.top + 2

      // Read an expanded chapter to its end before advancing to the next one.
      if (
        withinTallPage &&
        Math.abs(delta) <
          (direction > 0 ? bottom - root.scrollTop : root.scrollTop - page.top)
      )
        return
      event.preventDefault()
      if (wheelDirection !== direction) wheelDistance = 0
      wheelDirection = direction
      wheelDistance += Math.abs(delta)
      if (wheelDistance < 35) return

      let target = direction > 0 ? bottom : page.top
      if (!withinTallPage) {
        const next = positions[current + direction]
        if (!next) return
        target =
          direction > 0
            ? next.top
            : next.top + Math.max(0, next.height - availableHeight)
      }
      gestureHandled = true
      transitionUntil = performance.now() + (reducedMotion.matches ? 0 : 650)
      root.scrollTo({
        top: target,
        behavior: reducedMotion.matches ? 'instant' : 'smooth',
      })
    }
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const boundary =
          root.getBoundingClientRect().top + root.clientHeight * 0.45
        let current = 0
        pages.forEach((page, index) => {
          if (page.getBoundingClientRect().top <= boundary) current = index
        })
        setActive(current)
      })
    }
    const resize = new ResizeObserver(update)
    resize.observe(root)
    pages.forEach((page) => resize.observe(page))
    root.addEventListener('scroll', update, { passive: true })
    root.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKeyDown)
    update()
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(wheelIdle)
      resize.disconnect()
      root.removeEventListener('scroll', update)
      root.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  return (
    <div
      ref={scrollRef}
      className={styles.website}
      id="website-scroll"
      data-website-scroll
      lang="zh-CN"
    >
      {children}
      <nav
        className={styles.pageNav}
        data-tone={sections[active]?.tone}
        aria-label="官网章节"
      >
        {sections.map(({ id, name }, index) => (
          <a
            key={id}
            href={`#${id}`}
            aria-label={`第 ${index + 1} 屏：${name}`}
            aria-current={index === active ? 'step' : undefined}
          >
            <span className={styles.pageNavLabel}>{name}</span>
            <span className={styles.pageNavDot} />
          </a>
        ))}
        <span className={styles.pageCount} aria-hidden="true">
          0{active + 1}
          <span>/ 08</span>
        </span>
      </nav>
    </div>
  )
}
