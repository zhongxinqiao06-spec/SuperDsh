import Image from 'next/image'
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  ChevronDown,
  FileChartColumn,
  Layers3,
  MousePointer2,
  Network,
  ShieldCheck,
  Sparkles,
  Workflow,
} from 'lucide-react'
import { PlatformArchitecture } from './platform-architecture'
import { ProductShowcase } from './product-showcase'
import { WebsiteFrame } from './website-frame'
import { ScenarioShowcase, WebsiteHeader } from './website-interactions'
import styles from './website.module.css'

const capabilities = [
  {
    icon: BookOpen,
    number: '01',
    title: '你的知识，有据可循',
    text: '集中维护制度、产品资料和业务文档。回答附上来源，方便团队核对与持续补充。',
    label: '企业知识',
    detail: '资料管理 / 来源引用',
  },
  {
    icon: Workflow,
    number: '02',
    title: '你的方法，反复复用',
    text: '把分析口径、操作步骤和审核规则沉淀为技能，让团队复用验证过的方法。',
    label: '业务技能',
    detail: '标准步骤 / 版本管理',
  },
  {
    icon: FileChartColumn,
    number: '03',
    title: '你的标准，落在成果里',
    text: '结合企业模板生成可编辑的 Excel 与 PPT，让结论成为可检查、可修改的工作文件。',
    label: '办公成果',
    detail: '业务模板 / 文件交付',
  },
  {
    icon: Network,
    number: '04',
    title: '你的智能体，为业务而生',
    text: '组合模型、资料、技能和授权工具，配置经营分析、汇报等专属助手。',
    label: '专属智能体',
    detail: '自由组合 / 试用发布',
  },
]

const faqs = [
  {
    question: '星桥智能平台适合什么样的企业？',
    answer:
      '适合已经积累了业务文档、报表模板和工作规范，希望将它们用于日常 AI 工作的团队。可以先从经营分析、企业汇报、制度查询等边界清晰的场景开始，再逐步扩展。',
  },
  {
    question: '可以使用我们自己的资料、模板和模型吗？',
    answer:
      '可以。管理员选择资料、模板、技能、模型和授权工具，组合业务智能体。模板先按实际字段与版式适配，确认样例效果后再投入使用。',
  },
  {
    question: '生成的文件可以继续编辑吗？',
    answer:
      '可以。办公成果以 Excel 和 PPTX 等可编辑文件交付，可继续核对数据、调整内容和版式。官网展示使用虚构数据；实际文件由你在工作台发起的任务生成。',
  },
  {
    question: '企业共享、钉钉和企业微信支持到什么程度？',
    answer:
      '企业级成员共享、部门授权和钉钉／企业微信接入属于分阶段交付范围。连接企业应用前，需要完成应用授权、身份映射及联调；具体开放能力以实际部署版本为准。',
  },
  {
    question: '企业可以自己维护资料和智能体吗？',
    answer:
      '可以由授权人员维护资料、模板、技能和智能体，把新的业务经验持续补充进平台。软件交付与适配服务、模型调用、存储和运行资源分别明确范围，费用以具体交付方案为准。',
  },
]

const workflowSteps = [
  {
    title: '带入企业资产',
    text: '上传资料、业务规则与办公模板',
    icon: BookOpen,
  },
  {
    title: '组合业务能力',
    text: '选择模型、技能及允许使用的工具',
    icon: Layers3,
  },
  {
    title: '试用并发布',
    text: '验证过程与成果，固定配置版本',
    icon: MousePointer2,
  },
  { title: '在工作中复用', text: '员工发起任务，经验持续沉淀', icon: Workflow },
]

export function Website() {
  return (
    <WebsiteFrame>
      <a className={styles.skipLink} href="#main-content">
        跳至主要内容
      </a>
      <WebsiteHeader />
      <main id="main-content" tabIndex={-1}>
        <section
          id="top"
          className={styles.hero}
          data-website-section="首页"
          aria-labelledby="hero-title"
        >
          <div className={styles.heroArtwork}>
            <Image
              src="/images/website/starbridge-hero.webp"
              alt="由青柠色光束与深色金属构成的星桥，连接企业知识与业务行动"
              fill
              priority
              unoptimized
              sizes="(max-width: 760px) 100vw, 75vw"
            />
          </div>
          <div className={`${styles.container} ${styles.heroContent}`}>
            <div className={styles.eyebrow}>
              <span className={styles.liveDot} /> 企业自己的 AI 工作平台
            </div>
            <h1 id="hero-title">
              让企业经验，
              <br />
              成为团队的
              <br />
              <em>AI 能力。</em>
            </h1>
            <p className={styles.heroDescription}>
              把资料、模板和业务方法，变成专属智能体。
              <br />
              从一次提问，到一份可以交付的成果。
            </p>
            <div className={styles.heroActions}>
              <a href="/#/login" className={styles.primaryButton}>
                进入工作台 <ArrowUpRight size={18} />
              </a>
              <a href="#scenarios" className={styles.secondaryButton}>
                探索业务场景 <ArrowRight size={18} />
              </a>
            </div>
            <div className={styles.heroFootnote}>
              <span /> YOUR KNOWLEDGE. YOUR INTELLIGENCE.
            </div>
          </div>
          <div className={styles.artLabel}>
            <span className={styles.artLabelDot} />
            <div>
              连接知识与行动<small>THE BRIDGE TO POSSIBILITY</small>
            </div>
          </div>
          <a
            className={styles.scrollHint}
            href="#capabilities"
            aria-label="向下浏览产品能力"
          >
            <ArrowDown size={16} /> 向下探索
          </a>
          <div className={styles.principles}>
            <div className={styles.container}>
              <span className={styles.principlesLead}>为真实业务而构建</span>
              <span>
                <Layers3 /> 企业资产沉淀
              </span>
              <span>
                <Sparkles /> 业务智能体
              </span>
              <span>
                <FileChartColumn /> 可编辑办公成果
              </span>
              <span>
                <ShieldCheck /> 授权与过程可控
              </span>
            </div>
          </div>
        </section>

        <section
          id="capabilities"
          className={styles.capabilities}
          data-website-section="产品能力"
          aria-labelledby="capabilities-title"
        >
          <div className={styles.container}>
            <div className={styles.sectionHeading}>
              <div>
                <p className={styles.kicker}>BUILT AROUND YOUR BUSINESS</p>
                <h2 id="capabilities-title">
                  好用的 AI，
                  <br />
                  从懂你的企业开始。
                </h2>
              </div>
              <p className={styles.sectionIntro}>
                企业积累的经验，不止留在文档里。
                <br />
                将资料、工作方法和交付标准连接起来，
                <br />
                让每一次任务都能用上。
              </p>
            </div>
            <div className={styles.capabilityGrid}>
              {capabilities.map(
                ({ icon: Icon, number, title, text, label, detail }) => (
                  <article className={styles.capability} key={number}>
                    <div className={styles.capabilityTop}>
                      <Icon size={26} strokeWidth={1.5} />
                      <span>{number}</span>
                    </div>
                    <span className={styles.capabilityLabel}>{label}</span>
                    <h3>{title}</h3>
                    <p>{text}</p>
                    <small>{detail}</small>
                  </article>
                ),
              )}
            </div>
          </div>
        </section>

        <section
          id="scenarios"
          className={styles.scenarios}
          data-website-section="应用场景"
          aria-labelledby="scenarios-title"
        >
          <div className={styles.container}>
            <div className={styles.sectionHeading}>
              <div>
                <p className={styles.kicker}>FROM A TASK TO AN OUTCOME</p>
                <h2 id="scenarios-title">
                  <span className={styles.scenarioDesktopTitle}>
                    交给 AI 一个任务，带回一份真正的成果。
                  </span>
                  <span className={styles.scenarioMobileTitle}>
                    让 AI 交付真正的成果。
                  </span>
                </h2>
              </div>
              <span className={styles.sectionCounter}>
                01 — 03 <span>业务场景</span>
              </span>
            </div>
            <ScenarioShowcase />
          </div>
        </section>

        <section
          id="workflow"
          className={styles.workflow}
          data-website-section="使用流程"
          aria-labelledby="workflow-title"
        >
          <div className={styles.container}>
            <div className={styles.workflowHeading}>
              <p className={styles.kicker}>MAKE EXPERTISE REPEATABLE</p>
              <h2 id="workflow-title">四步，把企业经验交给 AI。</h2>
              <p>从一个明确场景开始，先验证结果，再持续复用。</p>
            </div>
            <div className={styles.workflowSteps}>
              {workflowSteps.map(({ title, text, icon: StepIcon }, index) => (
                <div key={title} className={styles.workflowStep}>
                  <div className={styles.stepTrack}>
                    <span>0{index + 1}</span>
                    <ArrowRight size={16} />
                  </div>
                  <StepIcon size={25} strokeWidth={1.5} />
                  <h3>{title}</h3>
                  <p>{text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <PlatformArchitecture />

        <section
          id="connected"
          className={styles.connected}
          data-website-section="多端体验"
          aria-labelledby="connected-title"
        >
          <div className={styles.container}>
            <div
              className={`${styles.sectionHeading} ${styles.productHeading}`}
            >
              <div>
                <p className={styles.kicker}>YOUR WORK. WITHIN REACH.</p>
                <h2 id="connected-title">大屏专注，随时接续。</h2>
              </div>
              <p className={styles.sectionIntro}>
                看得到任务过程，也拿得到工作成果。
                <br />
                在电脑与手机浏览器中，打开你的 AI 工作台。
              </p>
            </div>
            <ProductShowcase />
            <div className={styles.productFooter}>
              <span>Web / 桌面 / Android · 多端产品入口</span>
              <a href="/#/login" className={styles.textLink}>
                进入工作台体验 <ArrowUpRight size={17} />
              </a>
            </div>
          </div>
        </section>

        <section
          id="faq"
          className={styles.faq}
          data-website-section="常见问题"
          aria-labelledby="faq-title"
        >
          <div className={`${styles.container} ${styles.faqGrid}`}>
            <div>
              <p className={styles.kicker}>A LITTLE MORE CLARITY</p>
              <h2 id="faq-title">你可能还想了解</h2>
              <p className={styles.faqIntro}>
                从一个具体场景开始，
                <br />
                找到适合企业的落地方式。
              </p>
            </div>
            <div className={styles.faqList}>
              {faqs.map(({ question, answer }) => (
                <details key={question} className={styles.faqItem}>
                  <summary>
                    {question}
                    <ChevronDown size={18} />
                  </summary>
                  <p>{answer}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section
          id="start"
          className={styles.cta}
          data-website-section="开始使用"
          aria-labelledby="cta-title"
        >
          <div className={styles.container}>
            <p className={styles.kicker}>BUILD YOUR NEXT WAY OF WORKING</p>
            <h2 id="cta-title">
              你的企业，
              <br />
              值得拥有自己的 AI。
            </h2>
            <p>从一份资料、一个模板、一次真实任务开始。</p>
            <a href="/#/login" className={styles.primaryButton}>
              开启星桥工作台 <ArrowUpRight size={19} />
            </a>
            <span className={styles.ctaWatermark} aria-hidden="true">
              STARBRIDGE
            </span>
          </div>
          <footer className={styles.footer}>
            <div className={styles.container}>
              <a href="#top" className={styles.brand}>
                <Image src="/icon.svg" alt="" width={30} height={30} />
                <span>
                  星桥智能平台<small>STARBRIDGE</small>
                </span>
              </a>
              <p>连接知识与行动</p>
              <nav aria-label="页脚导航">
                <a href="#architecture">平台架构</a>
                <a href="/privacy">隐私政策</a>
                <a href="/#/login">
                  登录平台 <ArrowUpRight size={13} />
                </a>
              </nav>
              <small>© {new Date().getFullYear()} 星桥智能平台</small>
            </div>
          </footer>
        </section>
      </main>
    </WebsiteFrame>
  )
}
