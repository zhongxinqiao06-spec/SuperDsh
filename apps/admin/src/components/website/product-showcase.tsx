'use client'

import Image from 'next/image'
import { useRef, useState } from 'react'
import { ArrowUpRight, Monitor, Smartphone, X, ZoomIn } from 'lucide-react'
import styles from './product-showcase.module.css'

const screenshots = [
  {
    src: '/images/website/desktop-workbench.webp',
    title: '桌面工作台',
    label: 'DESKTOP WEB',
    description: '在大屏上梳理任务，查看分析过程与成果。',
    alt: '星桥桌面 Web 工作台，使用虚构业务数据展示任务与分析结果',
    width: 1440,
    height: 940,
    icon: Monitor,
  },
  {
    src: '/images/website/mobile-workbench.webp',
    title: '手机工作台',
    label: 'MOBILE WEB',
    description: '在手机浏览器中查看对话，随时跟进任务。',
    alt: '星桥手机 Web 工作台，展示适配小屏幕的任务对话',
    width: 390,
    height: 844,
    icon: Smartphone,
  },
  {
    src: '/images/website/agents-desktop.webp',
    title: '智能体管理',
    label: 'DESKTOP WEB',
    description: '围绕业务配置助手，让资料与工作方法持续复用。',
    alt: '星桥智能体管理界面，展示经营分析、企业汇报和制度问答等示例助手',
    width: 1440,
    height: 940,
    icon: Monitor,
  },
] as const

export function ProductShowcase() {
  const [mobileView, setMobileView] = useState(0)
  const [preview, setPreview] = useState(0)
  const [desktopView, setDesktopView] = useState<0 | 2>(0)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const selected = screenshots[preview] ?? screenshots[0]

  return (
    <div className={styles.showcase}>
      <div className={styles.mobileSwitch} aria-label="选择界面截图">
        {screenshots.slice(0, 2).map(({ title, icon: Icon }, index) => (
          <button
            type="button"
            key={title}
            aria-pressed={mobileView === index}
            onClick={() => setMobileView(index)}
          >
            <Icon size={16} /> {title}
          </button>
        ))}
      </div>
      <div className={styles.stage}>
        {[screenshots[desktopView], screenshots[1]].map((screenshot, index) => (
          <figure
            key={index === 0 ? 'desktop' : 'mobile'}
            className={index === 0 ? styles.desktop : styles.mobile}
            data-active={mobileView === index}
          >
            <button
              type="button"
              className={styles.screen}
              aria-label={`放大查看${screenshot.title}截图`}
              onClick={() => {
                setPreview(index === 0 ? desktopView : 1)
                dialogRef.current?.showModal()
              }}
            >
              {index === 0 && (
                <span className={styles.windowBar} aria-hidden="true">
                  <span>
                    <i />
                    <i />
                    <i />
                  </span>
                  星桥智能平台 <span>WORKSPACE</span>
                </span>
              )}
              <Image
                src={screenshot.src}
                alt={screenshot.alt}
                width={screenshot.width}
                height={screenshot.height}
                sizes={index === 0 ? '(max-width: 800px) 90vw, 800px' : '240px'}
                unoptimized
              />
              <span className={styles.zoom}>
                <ZoomIn size={16} /> 放大查看
              </span>
            </button>
            <figcaption>
              <span>{screenshot.label}</span>
              <div className={styles.captionTitle}>
                <strong>
                  {screenshot.title} <ArrowUpRight size={14} />
                </strong>
                {index === 0 && (
                  <div
                    className={styles.desktopSwitch}
                    aria-label="选择桌面界面"
                  >
                    <button
                      type="button"
                      aria-pressed={desktopView === 0}
                      onClick={() => setDesktopView(0)}
                    >
                      任务对话
                    </button>
                    <button
                      type="button"
                      aria-pressed={desktopView === 2}
                      onClick={() => setDesktopView(2)}
                    >
                      智能体管理
                    </button>
                  </div>
                )}
              </div>
              <p>{screenshot.description}</p>
            </figcaption>
          </figure>
        ))}
      </div>
      <p className={styles.note}>
        当前产品界面 · 虚构业务数据演示 · 手机截图为移动 Web 界面
      </p>
      <dialog
        ref={dialogRef}
        className={styles.preview}
        aria-label="工作台截图预览"
        onClick={(event) => {
          if (event.target === event.currentTarget) dialogRef.current?.close()
        }}
      >
        <div className={styles.previewContent}>
          <div className={styles.previewHeader}>
            <span>
              {selected.title}
              <small>产品界面 / 示例数据</small>
            </span>
            <button
              type="button"
              aria-label="关闭截图预览"
              onClick={() => dialogRef.current?.close()}
            >
              <X size={22} />
            </button>
          </div>
          <div className={styles.previewImage}>
            <Image
              src={selected.src}
              alt={selected.alt}
              width={selected.width}
              height={selected.height}
              unoptimized
            />
          </div>
        </div>
      </dialog>
    </div>
  )
}
