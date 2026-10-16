'use client'

import Image from 'next/image'
import { useRef, useState, type KeyboardEvent } from 'react'
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  FileSpreadsheet,
  FileText,
  Menu,
  Presentation,
  Sparkles,
  X,
} from 'lucide-react'
import styles from './website.module.css'

const links = [
  ['产品能力', '#capabilities'],
  ['应用场景', '#scenarios'],
  ['平台架构', '#architecture'],
  ['多端体验', '#connected'],
  ['常见问题', '#faq'],
]

export function WebsiteHeader() {
  const [menuOpen, setMenuOpen] = useState(false)
  const toggle = useRef<HTMLButtonElement>(null)
  return (
    <header
      className={styles.header}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setMenuOpen(false)
          toggle.current?.focus()
        }
      }}
    >
      <div className={styles.headerInner}>
        <a
          href="#top"
          className={styles.brand}
          aria-label="星桥智能平台首页"
          onClick={() => setMenuOpen(false)}
        >
          <Image src="/icon.svg" alt="" width={38} height={38} priority />
          <span>
            星桥智能平台<small>STARBRIDGE</small>
          </span>
        </a>
        <nav className={styles.desktopNav} aria-label="主导航">
          {links.map(([label, href]) => (
            <a key={href} href={href}>
              {label}
            </a>
          ))}
        </nav>
        <a className={styles.headerCta} href="/#/login">
          进入工作台 <ArrowUpRight size={16} />
        </a>
        <button
          ref={toggle}
          className={styles.menuToggle}
          type="button"
          aria-label={menuOpen ? '关闭导航' : '打开导航'}
          aria-expanded={menuOpen}
          aria-controls="website-mobile-nav"
          onClick={() => setMenuOpen(!menuOpen)}
        >
          {menuOpen ? <X /> : <Menu />}
        </button>
      </div>
      <nav
        id="website-mobile-nav"
        className={styles.mobileNav}
        aria-label="移动导航"
        hidden={!menuOpen}
      >
        {links.map(([label, href]) => (
          <a key={href} href={href} onClick={() => setMenuOpen(false)}>
            {label}
            <ArrowUpRight size={17} />
          </a>
        ))}
        <a href="/#/login" onClick={() => setMenuOpen(false)}>
          进入工作台 <ArrowUpRight size={17} />
        </a>
      </nav>
    </header>
  )
}

const scenarios = [
  {
    name: '经营分析',
    icon: FileSpreadsheet,
    kicker: '01 / BUSINESS ANALYTICS',
    title: '从一张销售表，\n看见下一步增长。',
    description:
      '读取销售明细，按区域与产品汇总，识别值得关注的变化。把核对后的数据，交付为可继续编辑的经营报表。',
    steps: [
      '带入销售明细与分析口径',
      '按业务规则计算与检查',
      '交付 Excel 报表与分析结论',
    ],
    input: '销售明细.csv',
    output: '经营分析.xlsx',
  },
  {
    name: '企业汇报',
    icon: Presentation,
    kicker: '02 / BUSINESS PRESENTATION',
    title: '用企业的表达，\n讲清楚业务的价值。',
    description:
      '将公司资料与经营结果组织成清晰叙事，沿用企业模板，从业绩回顾到行动计划，交付可编辑的汇报文件。',
    steps: [
      '选择企业资料与汇报模板',
      '组织数据、观点与行动建议',
      '检查版式并生成 PPTX',
    ],
    input: '分析结果 + 品牌模板',
    output: '季度经营汇报.pptx',
  },
  {
    name: '企业知识',
    icon: BookOpen,
    kicker: '03 / KNOWLEDGE ASSISTANT',
    title: '每一个好答案，\n都能找到它的依据。',
    description:
      '围绕企业制度与产品资料回答问题，附上来源供员工核对。资料没有覆盖的内容，明确说明，让信息更可靠。',
    steps: [
      '选择已上传的企业制度',
      '检索相关条款与上下文',
      '回答问题并提供资料来源',
    ],
    input: '差旅报销制度.pdf',
    output: '有来源的业务解答',
  },
]

const slides = [
  {
    label: '季度经营回顾',
    title: (
      <>
        每一份积累，
        <br />
        都在连接下一次增长。
      </>
    ),
    subtitle: '星河商贸 · 第三季度经营汇报',
    number: '01',
  },
  {
    label: '业务表现',
    title: (
      <>
        把数据看清，
        <br />
        让行动更有方向。
      </>
    ),
    subtitle: '季度销售额 ¥1,286,000 · 覆盖 4 个区域',
    number: '02',
  },
  {
    label: '下一步行动',
    title: (
      <>
        聚焦关键区域，
        <br />
        延续有效的工作方法。
      </>
    ),
    subtitle: '华东市场复盘 / 区域经验沉淀 / 下季度计划',
    number: '03',
  },
]

export function ScenarioShowcase() {
  const [active, setActive] = useState(0)
  const [slide, setSlide] = useState(0)
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const scenario = scenarios[active]!
  function changeTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % scenarios.length
        : event.key === 'ArrowLeft'
          ? (index + scenarios.length - 1) % scenarios.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? scenarios.length - 1
              : null
    if (next === null) return
    event.preventDefault()
    setActive(next)
    tabs.current[next]?.focus()
  }
  return (
    <>
      <div
        className={styles.scenarioTabs}
        role="tablist"
        aria-label="业务应用场景"
      >
        {scenarios.map(({ name, icon: Icon }, index) => (
          <button
            key={name}
            ref={(element) => {
              tabs.current[index] = element
            }}
            type="button"
            role="tab"
            id={`scenario-tab-${index}`}
            aria-selected={active === index}
            aria-controls="scenario-panel"
            tabIndex={active === index ? 0 : -1}
            onKeyDown={(event) => changeTab(event, index)}
            onClick={() => setActive(index)}
          >
            <Icon size={19} />
            {name}
            <span>0{index + 1}</span>
          </button>
        ))}
      </div>
      <div
        className={styles.scenarioPanel}
        role="tabpanel"
        id="scenario-panel"
        aria-labelledby={`scenario-tab-${active}`}
        tabIndex={0}
      >
        <div className={styles.scenarioCopy}>
          <p className={styles.kicker}>{scenario.kicker}</p>
          <h3>
            {scenario.title.split('\n').map((line) => (
              <span key={line}>{line}</span>
            ))}
          </h3>
          <p className={styles.scenarioDescription}>{scenario.description}</p>
          <ul className={styles.scenarioSteps}>
            {scenario.steps.map((step) => (
              <li key={step}>
                <Check size={15} />
                {step}
              </li>
            ))}
          </ul>
          <details key={active} className={styles.mobileSteps}>
            <summary>
              查看场景与工作步骤 <ChevronRight size={15} />
            </summary>
            <p>{scenario.description}</p>
            <ul>
              {scenario.steps.map((step) => (
                <li key={step}>
                  <Check size={15} />
                  {step}
                </li>
              ))}
            </ul>
          </details>
          <a href="/#/login" className={styles.textLink}>
            在工作台开始 <ArrowUpRight size={16} />
          </a>
        </div>
        <div className={styles.demoWindow}>
          <div className={styles.windowBar}>
            <span className={styles.windowDots}>
              <i />
              <i />
              <i />
            </span>
            <span>星桥 / {scenario.name}助手</span>
            <span className={styles.demoBadge}>场景示意</span>
          </div>
          <div className={styles.demoBody}>
            <div className={styles.demoFlow}>
              <span>
                <FileText size={13} />
                {scenario.input}
              </span>
              <ArrowRight size={15} />
              <span>
                <Sparkles size={13} />
                {scenario.output}
              </span>
            </div>
            {active === 0 && (
              <div className={styles.salesDemo}>
                <div className={styles.reportTitle}>
                  <div>
                    <small>星河商贸 · 季度经营概览</small>
                    <h4>把业务，看得更清楚。</h4>
                  </div>
                  <span>Q3</span>
                </div>
                <div className={styles.reportMetrics}>
                  <div>
                    <small>季度销售额 / CNY</small>
                    <strong>
                      1,286,000<span>.00</span>
                    </strong>
                  </div>
                  <div>
                    <small>覆盖区域</small>
                    <strong>04</strong>
                  </div>
                </div>
                <div className={styles.reportCharts}>
                  <div className={styles.barChart}>
                    <span>
                      月度销售趋势 <small>单位：万元</small>
                    </span>
                    <div className={styles.bars}>
                      {[38.6, 41.6, 48.4].map((value, index) => (
                        <div key={value}>
                          <span>{value}</span>
                          <i style={{ height: `${value * 2}px` }} />
                          <small>{index + 7} 月</small>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className={styles.regionTable}>
                    <span>区域表现</span>
                    {[
                      ['华东', '486,000', 100],
                      ['华南', '352,000', 72],
                      ['华北', '268,000', 55],
                      ['西部', '180,000', 37],
                    ].map(([name, value, width]) => (
                      <div key={name}>
                        <span>
                          {name}
                          <b>{value}</b>
                        </span>
                        <i style={{ width: `${width}%` }} />
                      </div>
                    ))}
                  </div>
                </div>
                <div className={styles.reportFooter}>
                  <span>
                    <CheckCheck size={15} /> 汇总结果与示例明细一致
                  </span>
                  <a href="/images/website/sales-example.csv" download>
                    <ArrowDownToLine size={14} /> 示例数据
                  </a>
                </div>
              </div>
            )}
            {active === 1 && (
              <div className={styles.presentationDemo}>
                <div className={styles.presentationSlide}>
                  <div className={styles.slideTop}>
                    <span>星河商贸 XINGHE</span>
                    <span>{slides[slide]!.label}</span>
                  </div>
                  <span className={styles.slideCircle} />
                  <div className={styles.slideContent}>
                    <small>GROWING, TOGETHER.</small>
                    <h4>{slides[slide]!.title}</h4>
                    <p>{slides[slide]!.subtitle}</p>
                  </div>
                  <span className={styles.slideNumber}>
                    {slides[slide]!.number}
                  </span>
                </div>
                <div className={styles.slideControls}>
                  <span>企业品牌模板 · 示例预览</span>
                  <div>
                    <button
                      type="button"
                      aria-label="上一页演示"
                      onClick={() =>
                        setSlide((slide + slides.length - 1) % slides.length)
                      }
                    >
                      <ChevronLeft size={17} />
                    </button>
                    <span>
                      {slide + 1} / {slides.length}
                    </span>
                    <button
                      type="button"
                      aria-label="下一页演示"
                      onClick={() => setSlide((slide + 1) % slides.length)}
                    >
                      <ChevronRight size={17} />
                    </button>
                  </div>
                </div>
              </div>
            )}
            {active === 2 && (
              <div className={styles.knowledgeDemo}>
                <div className={styles.demoQuestion}>
                  出差两天，住宿费用怎么报销？
                </div>
                <div className={styles.demoAnswer}>
                  <div className={styles.answerAuthor}>
                    <Sparkles size={16} />
                    企业制度助手
                  </div>
                  <p>根据《星河商贸差旅报销制度》：</p>
                  <ul>
                    <li>住宿费按实际住宿晚数和对应城市标准报销。</li>
                    <li>提交合规发票，并关联已审批的出差申请。</li>
                  </ul>
                  <p className={styles.answerNote}>
                    还需要确认你的出差城市和实际住宿晚数，才能核对适用标准。
                  </p>
                  <details className={styles.sourceDetail}>
                    <summary>
                      <FileText size={15} /> 查看引用 · 差旅报销制度 §3.2{' '}
                      <ChevronRight size={14} />
                    </summary>
                    <p>
                      示例条款：住宿费用按实际发生且不超过城市标准的金额报销。员工应提供住宿发票及已审批的出差申请。此条款为虚构展示内容。
                    </p>
                  </details>
                </div>
              </div>
            )}
          </div>
          <div className={styles.demoDisclaimer}>
            <span /> 虚构企业「星河商贸」示例 · 非实时运行结果
          </div>
        </div>
      </div>
    </>
  )
}
