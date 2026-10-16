/** Capture owned Web UI using fictional, browser-local API fixtures only. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(root, 'apps/desktop/package.json'))
const { chromium } = require('playwright')
const sharp = require('sharp')
const baseUrl = process.env.WEBSITE_CAPTURE_URL || 'http://127.0.0.1:5174'
const output = path.join(root, 'apps/admin/public/images/website')
const diagnostics = path.join(root, '.superdsh/website-product-capture')
const serverTime = '2026-10-16T02:30:00.000Z'
const permissions = [
  'sessions.read',
  'sessions.run',
  'devices.read',
  'devices.manage',
  'projects.read',
  'projects.manage',
  'models.use',
  'agents.manage',
]
const me = {
  userId: 'demo-xinghe',
  username: 'xinghe-demo',
  displayName: '星河商贸 · 演示',
  email: null,
  emailVerified: true,
  role: 'member',
  roles: ['员工'],
  permissions,
  authzVersion: 1,
  disabled: false,
  avatar: null,
  serverTime,
}
const connector = {
  id: 'demo-server',
  userId: me.userId,
  name: '企业工作空间',
  executorKind: 'server-agent',
  deviceOs: 'linux',
  status: 'online',
  lastSeenAt: serverTime,
  createdAt: serverTime,
  updatedAt: serverTime,
}
const agent = {
  id: 'demo-analysis',
  name: '经营分析助手',
  description: '读取企业销售资料，按统一口径输出分析与报告。',
  instructions: '以提供的资料为准，引用来源；缺失数据明确说明，不编造。',
  knowledgeBaseIds: ['demo-knowledge'],
  knowledgeAssetIds: ['demo-sales'],
  templateAssetIds: [],
  skillIds: ['sales-analysis'],
  toolIds: ['knowledge_search'],
  published: true,
  version: 3,
  createdAt: serverTime,
  updatedAt: serverTime,
}
const session = {
  id: 'demo-quarterly',
  connectorId: connector.id,
  projectId: 'demo-project',
  connectorStatus: 'online',
  executorKind: 'server-agent',
  runtime: 'dsh',
  runtimeId: 'dsh',
  runtimeType: 'dsh',
  runtimeName: '企业智能体',
  runtimeTypeDisplayName: '星桥智能体',
  externalSessionId: 'demo-quarterly-native',
  title: '第三季度经营复盘',
  cwd: '/workspace/星河商贸',
  status: 'idle',
  takeover: true,
  pinned: true,
  pinnedAt: serverTime,
  archived: false,
  archivedAt: null,
  unread: false,
  lastReadSeq: 2,
  latestTurnEndSeq: 2,
  lastSyncedAt: serverTime,
  sourceObservedAt: serverTime,
  lastActivityAt: serverTime,
  lastItemAt: serverTime,
  lastItemOrderSeq: 2,
  sortAt: serverTime,
  updatedSeq: 2,
  effectiveRunMode: 'chat',
  sourceAvailability: 'available',
  agentDefinition: { id: agent.id, name: agent.name, version: agent.version },
}
const sessions = [
  session,
  {
    ...session,
    id: 'demo-onboarding',
    title: '新员工入职指引',
    pinned: false,
    projectId: null,
    agentDefinition: null,
  },
  {
    ...session,
    id: 'demo-report',
    title: '月度管理层汇报',
    pinned: false,
    projectId: null,
    agentDefinition: null,
  },
]
const project = {
  id: 'demo-project',
  userId: me.userId,
  connectorId: connector.id,
  name: '星河商贸 · 经营分析',
  workspacePath: session.cwd,
  manuallyCreated: true,
  pinned: false,
  pinnedAt: null,
  activeSessionCount: 1,
  lastActivityAt: serverTime,
  createdAt: serverTime,
  updatedAt: serverTime,
}
const texts = [
  '分析第三季度销售数据，给出下季度行动建议。',
  '## 第三季度经营复盘\n\n| 核心指标 | 本季度 | 环比 |\n| --- | ---: | ---: |\n| 销售额 | ¥ 1,286 万 | +18.6% |\n| 新增客户 | 246 家 | +12.8% |\n| 客户续约率 | 92.4% | +3.2pp |\n\n**华东区域贡献增长主力。** 销售额占比 42%，重点客户复购带动增长。\n\n**下季度建议**：复用华东客户运营方法，优先改善华南首次交付体验。\n\n来源：第三季度销售台账（演示数据）。',
]
const items = texts.map((text, index) => ({
  id: `demo-message-${index}`,
  sessionId: session.id,
  type: 'message',
  status: 'done',
  role: index === 0 ? 'user' : 'assistant',
  content: { text },
  source: { runtime: 'dsh', sessionId: session.externalSessionId },
  orderSeq: index + 1,
  revision: 1,
  contentHash: `demo-${index}`,
  updatedSeq: index + 1,
  createdAt: serverTime,
  updatedAt: serverTime,
  completedAt: serverTime,
}))
const capabilities = {
  revision: 1,
  capabilities: [
    'session.message.send',
    'session.model.select',
    'session.permission.select',
  ].map((capabilityId) => ({
    capabilityId,
    scope: 'session',
    runtime: 'dsh',
    sessionId: session.id,
    version: '1',
    supported: true,
    available: true,
    allowed: true,
    unavailableReason: null,
  })),
}
const timeline = { items, hasMore: false, nextSeq: 2 }
const snapshot = {
  session,
  state: {
    sessionId: session.id,
    status: 'idle',
    updatedSeq: 2,
    runtime: 'dsh',
    externalSessionId: session.externalSessionId,
    metadata: {},
    createdAt: serverTime,
    updatedAt: serverTime,
  },
  timeline,
  approvals: [],
  notices: [],
  catalogs: {},
  effectiveCapabilities: capabilities,
  runtimeCapabilities: capabilities,
  eventCursor: 'seq:2',
  serverTime,
}
const navigation = [
  ['overview', '总览', 'gauge'],
  ['workbench', 'Agent 工作台', 'bot'],
  ['agents', '智能体列表', 'bot'],
  ['knowledge', '知识库', 'book-open'],
  ['skills', '技能管理', 'sparkles'],
  ['tools', '工具管理', 'wrench'],
  ['account.profile', '账号资料', 'user'],
].map(([moduleId, title, icon], order) => ({
  id: moduleId,
  kind: 'page',
  moduleId,
  parentId: null,
  title,
  icon,
  order,
  visible: true,
  roleIds: [],
}))
const catalog = {
  assets: [
    {
      id: 'demo-sales',
      name: '第三季度销售台账.csv',
      kind: 'knowledge',
      size: 38400,
      preview: '区域,销售额\n华东,540.12\n华南,308.64',
      sha256: 'fictional-demo',
      createdAt: serverTime,
    },
  ],
  knowledgeBases: [
    {
      id: 'demo-knowledge',
      name: '企业经营资料',
      description: '销售口径、客户运营与季度复盘',
      enabled: true,
      version: 1,
      assetIds: ['demo-sales'],
      createdAt: serverTime,
      updatedAt: serverTime,
    },
  ],
  skills: [
    {
      id: 'sales-analysis',
      name: '经营数据分析',
      description: '统一指标口径，分析增长与风险',
      instructions: '先校验来源，再计算与总结。',
      requiredToolIds: ['knowledge_search'],
      enabled: true,
      version: 1,
      createdAt: serverTime,
      updatedAt: serverTime,
    },
  ],
  tools: [
    {
      id: 'knowledge_search',
      name: '企业知识检索',
      description: '查找已授权的企业资料',
      enabled: true,
      version: 1,
      settings: {},
      createdAt: serverTime,
      updatedAt: serverTime,
    },
  ],
}
const agents = [
  agent,
  {
    ...agent,
    id: 'demo-knowledge-agent',
    name: '企业知识助手',
    description: '从制度与业务资料中查找答案，保留依据与出处。',
    version: 2,
  },
  {
    ...agent,
    id: 'demo-slides-agent',
    name: '汇报材料助手',
    description: '整理业务重点，按企业模板输出清晰的汇报结构。',
    version: 1,
  },
]

await mkdir(output, { recursive: true })
await mkdir(diagnostics, { recursive: true })
const browser = await chromium.launch({ headless: true })
const unknown = new Set()
try {
  for (const viewport of [
    { width: 1440, height: 940 },
    { width: 390, height: 844 },
  ]) {
    const mobile = viewport.width < 600
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: mobile ? 2 : 1.5,
      isMobile: mobile,
      hasTouch: mobile,
      locale: 'zh-CN',
      colorScheme: 'light',
      reducedMotion: 'reduce',
    })
    await context.addInitScript(() => {
      localStorage.setItem('theme', 'light')
      localStorage.setItem('locale', 'zh-CN')
    })
    await context.route('**/api/v2/**', async (route) => {
      const request = route.request()
      const endpoint = new URL(request.url()).pathname.replace(
        /^.*\/api\/v2/,
        '',
      )
      let json
      if (endpoint === '/auth/config')
        json = {
          needsBootstrap: false,
          registrationOpen: false,
          oauthEnabled: false,
          emailVerificationRequired: false,
          serverTime,
        }
      else if (endpoint === '/auth/refresh')
        json = {
          ...me,
          accessToken: 'fictional-browser-only-token',
          tokenType: 'bearer',
          expiresIn: 3600,
        }
      else if (endpoint === '/auth/me') json = me
      else if (endpoint === '/navigation')
        json = { version: 1, items: navigation }
      else if (endpoint === '/announcement') json = { announcement: null }
      else if (endpoint === '/connectors')
        json = { connectors: [connector], serverTime }
      else if (endpoint === '/projects')
        json = { projects: [project], serverTime }
      else if (
        endpoint === '/sessions/list' ||
        endpoint === '/sessions' ||
        endpoint === '/sessions/read'
      )
        json = { sessions, hasMore: false, nextCursor: null, serverTime }
      else if (endpoint.endsWith('/snapshot')) json = snapshot
      else if (endpoint.endsWith('/timeline'))
        json = { ...timeline, session, serverTime }
      else if (endpoint.endsWith('/agent-artifacts'))
        json = {
          agentDefinition: session.agentDefinition,
          items: [
            {
              fileId: 'demo-report',
              name: '第三季度经营复盘.xlsx',
              mediaType:
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              size: 48320,
              createdAt: serverTime,
            },
          ],
        }
      else if (endpoint === '/server-agent')
        json = {
          agent: {
            status: 'running',
            connectorId: connector.id,
            runtimeId: 'dsh',
            projectId: project.id,
            error: null,
          },
        }
      else if (endpoint === '/ws-ticket')
        json = { ticket: 'fixture-only', expiresAt: serverTime, serverTime }
      else if (endpoint.endsWith('/commands'))
        json = { commands: [], serverTime }
      else if (endpoint === '/agents' || endpoint === '/admin/agents')
        json = { items: agents, total: agents.length }
      else if (endpoint === '/admin/agents/catalog') json = catalog
      else if (endpoint === '/admin/agents/initialize') json = { ok: true }
      else if (endpoint.endsWith('/models'))
        json = { catalog: { models: [] }, models: [], serverTime }
      else if (endpoint.endsWith('/permissions'))
        json = { catalog: { permissions: [] }, permissions: [], serverTime }
      else if (endpoint.endsWith('/capabilities'))
        json = { capabilities, effectiveCapabilities: capabilities, serverTime }
      else if (endpoint.endsWith('/runtimes'))
        json = { runtimes: [], serverTime }
      else if (endpoint.endsWith('/state'))
        json = { state: snapshot.state, session, serverTime }
      else {
        unknown.add(`${request.method()} ${endpoint}`)
        return route.fulfill({
          status: 404,
          json: { message: 'Unconfigured screenshot fixture' },
        })
      }
      await route.fulfill({ status: 200, json })
    })
    await context.routeWebSocket(/\/api\/v2\//, (socket) =>
      socket.onMessage(() => {}),
    )
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`${baseUrl}/#/workspace/session/${session.id}`, {
      waitUntil: 'domcontentloaded',
    })
    await page
      .getByText('第三季度经营复盘', { exact: true })
      .first()
      .waitFor({ timeout: 60000 })
    await page
      .getByText('华东区域贡献增长主力。', { exact: true })
      .waitFor({ timeout: 60000 })
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(1200)
    const name = mobile ? 'mobile-workbench' : 'desktop-workbench'
    await writeFile(
      path.join(diagnostics, `${name}.txt`),
      await page.locator('body').innerText(),
    )
    const png = await page.screenshot({ animations: 'disabled' })
    await writeFile(path.join(diagnostics, `${name}.png`), png)
    await sharp(png)
      .webp({ quality: 90 })
      .toFile(path.join(output, `${name}.webp`))
    if (!mobile) {
      await page.goto(`${baseUrl}/#/agents`, { waitUntil: 'domcontentloaded' })
      await page.getByText('汇报材料助手', { exact: true }).waitFor()
      await page.evaluate(() => document.fonts.ready)
      const agentsPng = await page.screenshot({ animations: 'disabled' })
      await writeFile(path.join(diagnostics, 'agents-desktop.png'), agentsPng)
      await sharp(agentsPng)
        .webp({ quality: 90 })
        .toFile(path.join(output, 'agents-desktop.webp'))
    }
    assert.deepEqual(errors, [], `${name}: browser errors`)
    await context.close()
  }
} finally {
  await browser.close()
}
assert.deepEqual(
  [...unknown],
  [],
  'Every API request must have a documented fixture',
)
console.log(
  JSON.stringify(
    {
      assets: [
        'desktop-workbench.webp',
        'mobile-workbench.webp',
        'agents-desktop.webp',
      ],
    },
    null,
    2,
  ),
)
