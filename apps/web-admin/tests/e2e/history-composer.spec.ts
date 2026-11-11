import { expect, test } from '@playwright/test'
import { installFoundationFixture } from './foundation-fixture'
import type {
  SessionSnapshot,
  WorkspaceSession,
} from '../../fronted/src/types/workbench/models'

/** 合成状态专门验证历史输入栏排版；真实聊天验收另由 live-workbench-probe 执行。 */
for (const theme of ['light', 'dark']) {
  test(`历史输入栏：${theme} 空闲、执行、只读与窄屏`, async ({
    page,
  }, info) => {
    await page.addInitScript(
      (value) => localStorage.setItem('starbridge.theme', value),
      theme,
    )
    const fixture = await installFoundationFixture(page, [
      'menus.read',
      'devices.read',
      'devices.manage',
      'sessions.read',
      'sessions.run',
      'models.use',
    ])
    fixture.agentStatus = 'running'
    const sessions: WorkspaceSession[] = ['idle', 'running', 'readonly'].map(
      (state) => ({
        id: `synthetic-${state}`,
        connectorId: 'connector',
        executorKind: 'server-agent',
        projectId: null,
        runtime: 'dsh',
        runtimeId: 'dsh',
        title: `历史-${state}`,
        cwd: '/synthetic',
        status: state === 'running' ? 'running' : 'idle',
        pinned: false,
        archived: false,
        takeover: state !== 'readonly',
        unread: false,
        updatedSeq: 1,
        connectorStatus: 'online',
        agentDefinition: null,
      }),
    )
    await page.route('**/api/sessions**', async (route) => {
      const path = new URL(route.request().url()).pathname
      if (path === '/api/sessions' || path === '/api/sessions/list')
        return route.fulfill({ json: { sessions, nextCursor: null } })
      if (path.endsWith('/agent-binding'))
        return route.fulfill({
          json: { agentDefinition: null, bindingVersion: 0 },
        })
      if (path.endsWith('/snapshot')) {
        const session = sessions.find((item) => path.includes(item.id))!
        const snapshot: SessionSnapshot = {
          session,
          state: {
            selections: {
              model: 'opaque-model',
              permission: 'opaque-permission',
            },
          },
          timeline: { items: [], nextSeq: null, hasMore: false },
          notices: [],
          approvals: [],
          effectiveCapabilities: {
            capabilities: ['catalog.model', 'catalog.permission'].map(
              (capabilityId) => ({
                capabilityId,
                supported: true,
                available: true,
                allowed: true,
              }),
            ),
          },
          eventCursor: '',
        }
        return route.fulfill({ json: snapshot })
      }
      return route.fulfill({ json: {} })
    })
    await page.route('**/api/ws-ticket', (route) =>
      route.fulfill({ json: { ticket: 'synthetic' } }),
    )
    await page.routeWebSocket('**/api/sessions/*/ws*', () => {})
    for (const [kind, field, displayName] of [
      ['model', 'models', '合成默认模型'],
      ['permission', 'permissions', '工作区内修改'],
    ]) {
      await page.route(`**/catalogs/${kind}`, (route) =>
        route.fulfill({
          json: {
            [field!]: [
              {
                id: kind,
                displayName,
                selectionId: `opaque-${kind}`,
                enabled: true,
                default: true,
              },
            ],
          },
        }),
      )
    }
    await page.goto('/#/login')
    await page.getByLabel('用户名或邮箱').fill('admin')
    await page.getByLabel('密码', { exact: true }).fill('Synthetic-password!')
    await page.getByRole('button', { name: '登录 ↵', exact: true }).click()
    await expect(page.locator('[data-console-shell]')).toBeVisible()
    await page.goto('/#/workspace')
    for (const session of sessions) {
      await page.setViewportSize({ width: 1440, height: 1000 })
      const sidebarToggle = page.getByRole('button', {
        name: '切换会话侧栏',
        exact: true,
      })
      if ((await sidebarToggle.getAttribute('aria-expanded')) === 'false')
        await sidebarToggle.click()
      await page
        .locator('.session-main')
        .filter({ hasText: session.title })
        .click()
      await expect(page).toHaveURL(new RegExp(session.id))
      await expect(page.locator('.composer')).toContainText('通用对话')
      await expect(page.locator('.composer')).toContainText('合成默认模型')
      await expect(page.locator('.composer')).toContainText('工作区内修改')
      const draft = page.getByLabel('任务草稿')
      if (session.takeover && session.status === 'idle')
        await expect(draft).toBeEnabled()
      else await expect(draft).toBeDisabled()
      await expect(draft).toHaveCSS('border-width', '0px')
      await expect(draft).toHaveCSS('box-shadow', 'none')
      for (const width of [1440, 1204, 900, 390]) {
        await page.setViewportSize({ width, height: 1000 })
        if (width === 390) await sidebarToggle.click()
        const geometry = await page.locator('.composer').evaluate((card) => {
          const bounds = card.getBoundingClientRect()
          const controls = [
            ...card.querySelectorAll('.composer-options .el-select'),
          ].map((item) => item.getBoundingClientRect())
          const actions = [
            ...card.querySelectorAll('.composer-actions button, .el-switch'),
          ]
            .map((item) => item.getBoundingClientRect())
            .filter((item) => item.width)
          return {
            fits: [...controls, ...actions].every(
              (rect) => rect.left >= bounds.left && rect.right <= bounds.right,
            ),
            selectRows: new Set(controls.map((rect) => Math.round(rect.y)))
              .size,
            pageFits: document.documentElement.scrollWidth <= innerWidth,
          }
        })
        expect(geometry).toEqual({ fits: true, selectRows: 1, pageFits: true })
        await page.screenshot({
          path: info.outputPath(
            `${session.status}-${session.takeover}-${width}.png`,
          ),
          animations: 'disabled',
        })
      }
    }
  })
}
