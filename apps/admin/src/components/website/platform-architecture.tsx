import {
  ArrowDown,
  ArrowUpRight,
  Blocks,
  Bot,
  Cable,
  Cpu,
  Database,
  FolderOpen,
  Globe2,
  Layers3,
  Monitor,
  ShieldCheck,
  Smartphone,
  Workflow,
} from 'lucide-react'
import styles from './platform-architecture.module.css'

const advantages = [
  {
    icon: Layers3,
    title: '业务能力，持续沉淀',
    description: '让知识、模板与工作方法，成为可复用的企业资产。',
  },
  {
    icon: ShieldCheck,
    title: '执行过程，人可掌控',
    description: '从工具调用到关键审批，让任务过程清晰可见。',
  },
  {
    icon: Cable,
    title: '开放连接，分步拓展',
    description: '围绕业务需要，逐步连接模型、工具与企业系统。',
  },
]

export function PlatformArchitecture() {
  const advantageItems = advantages.map(
    ({ icon: Icon, title, description }) => (
      <div className={styles.advantage} key={title}>
        <Icon size={23} strokeWidth={1.4} aria-hidden="true" />
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
      </div>
    ),
  )

  return (
    <section
      className={styles.section}
      id="architecture"
      data-website-section="平台架构"
      aria-labelledby="architecture-heading"
    >
      <div className={styles.inner}>
        <div className={styles.introduction}>
          <div>
            <p className={styles.eyebrow}>
              <span aria-hidden="true" />
              PLATFORM ARCHITECTURE / 平台架构
            </p>
            <h2 id="architecture-heading">
              从企业知识，
              <br />
              到业务行动。
            </h2>
          </div>
          <p className={styles.summary}>
            将资料、业务方法和执行能力连接起来。
            <br />
            以统一平台承载企业的 AI 工作，让每一次积累，
            <br className={styles.desktopBreak} />
            都能服务下一次业务行动。
          </p>
          <p className={styles.mobileSummary}>
            连接企业知识、业务方法与执行能力，
            <br />
            让每次积累，服务下一次业务行动。
          </p>
        </div>

        <figure
          className={styles.diagram}
          aria-label="星桥智能平台四层架构示意"
        >
          <div className={styles.diagramHeader}>
            <div className={styles.diagramBrand}>
              <Blocks size={19} strokeWidth={1.5} aria-hidden="true" />
              <span>星桥智能平台</span>
            </div>
            <span className={styles.diagramCode}>SYSTEM OVERVIEW — 01</span>
          </div>

          <div className={styles.layers}>
            <div className={styles.layer}>
              <div className={styles.layerLabel}>
                <span className={styles.layerNumber}>01</span>
                <div>
                  <strong>多端入口</strong>
                  <span>ACCESS</span>
                </div>
              </div>
              <div className={styles.accessLayer}>
                <div>
                  <Globe2 size={23} strokeWidth={1.4} aria-hidden="true" />
                  <span>Web 工作台</span>
                </div>
                <div>
                  <Monitor size={23} strokeWidth={1.4} aria-hidden="true" />
                  <span>桌面端</span>
                </div>
                <div>
                  <Smartphone size={22} strokeWidth={1.4} aria-hidden="true" />
                  <span>Android</span>
                </div>
              </div>
            </div>

            <div className={styles.connector} aria-hidden="true">
              <ArrowDown size={14} strokeWidth={1.2} />
            </div>

            <div className={styles.layer}>
              <div className={styles.layerLabel}>
                <span className={styles.layerNumber}>02</span>
                <div>
                  <strong>产品能力</strong>
                  <span>PRODUCT</span>
                  <em>产品设计</em>
                </div>
              </div>
              <div className={styles.productLayer}>
                <div>
                  <FolderOpen size={22} strokeWidth={1.4} aria-hidden="true" />
                  <h3>企业资产</h3>
                  <p>知识 / 模板 / 技能</p>
                </div>
                <div>
                  <Bot size={23} strokeWidth={1.4} aria-hidden="true" />
                  <h3>智能体配置</h3>
                  <p>模型 / 授权工具 / 发布版本</p>
                </div>
                <div>
                  <Workflow size={22} strokeWidth={1.4} aria-hidden="true" />
                  <h3>员工工作台</h3>
                  <p>会话 / 任务 / 成果</p>
                </div>
              </div>
            </div>

            <div className={styles.connector} aria-hidden="true">
              <ArrowDown size={14} strokeWidth={1.2} />
            </div>

            <div className={styles.layer}>
              <div className={styles.layerLabel}>
                <span className={styles.layerNumber}>03</span>
                <div>
                  <strong>平台服务</strong>
                  <span>PLATFORM</span>
                </div>
              </div>
              <div className={styles.serviceLayer}>
                <div>
                  <ShieldCheck size={21} strokeWidth={1.4} aria-hidden="true" />
                  <strong>统一平台服务</strong>
                </div>
                <p>身份认证 · 角色权限 · 文件与审计</p>
              </div>
            </div>

            <div className={styles.connector} aria-hidden="true">
              <ArrowDown size={14} strokeWidth={1.2} />
            </div>

            <div className={styles.layer}>
              <div className={styles.layerLabel}>
                <span className={styles.layerNumber}>04</span>
                <div>
                  <strong>执行基础</strong>
                  <span>EXECUTION</span>
                </div>
              </div>
              <div className={styles.executionLayer}>
                <div className={styles.engine}>
                  <div className={styles.engineIcon}>
                    <Cpu size={26} strokeWidth={1.35} aria-hidden="true" />
                  </div>
                  <div>
                    <span>核心执行引擎</span>
                    <strong>Harness</strong>
                    <p>任务 / 工具 / 审批 / 取消</p>
                  </div>
                  <span className={styles.engineDot} aria-hidden="true" />
                </div>
                <div className={styles.infrastructure}>
                  <div>
                    <Database size={17} strokeWidth={1.5} aria-hidden="true" />
                    <span>基础设施与模型</span>
                  </div>
                  <p>
                    PostgreSQL <span>/</span> Redis <span>/</span> 模型服务
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className={styles.integrationRow}>
            <span className={styles.integrationLabel}>
              <Cable size={17} strokeWidth={1.5} aria-hidden="true" />
              企业系统连接
            </span>
            <div>
              <span>钉钉</span>
              <span className={styles.integrationDivider} aria-hidden="true" />
              <span>企业微信</span>
              <span className={styles.planned}>接入规划</span>
            </div>
            <ArrowUpRight
              className={styles.integrationArrow}
              size={18}
              strokeWidth={1.3}
              aria-hidden="true"
            />
          </div>
          <figcaption className={styles.caption}>
            <span aria-hidden="true">*</span>
            架构示意 · 企业共享与外部连接按交付阶段逐步开放
          </figcaption>
        </figure>

        <div className={styles.desktopAdvantages}>
          <div className={styles.advantages}>{advantageItems}</div>
        </div>
        <details className={styles.advantagesDisclosure}>
          <summary>了解架构设计</summary>
          <div className={styles.advantages}>{advantageItems}</div>
        </details>
      </div>
    </section>
  )
}
