import { expect, test } from '@playwright/test'
import { installFoundationFixture } from './foundation-fixture'
import type {
  SessionSnapshot,
  WorkspaceSession,
} from '../../fronted/src/types/workbench/models'

/** 延迟真实 UI 的快照请求，检测首次发送和继续提问期间是否清空选项或重建订阅。 */
test('配置来源清晰，默认选择贯穿首次和连续发送', async ({ page }, info) => {
  const fixture = await installFoundationFixture(page, [
    'menus.read',
    'devices.read',
    'devices.manage',
    'sessions.read',
    'sessions.run',
    'models.use',
  ])
  fixture.agentStatus = 'running'
  const session: WorkspaceSession = {
    id: 'synthetic-flow',
    connectorId: 'connector',
    projectId: 'managed-project',
    runtime: 'dsh',
    runtimeId: 'dsh',
    title: '连续对话验证',
    cwd: '/synthetic',
    status: 'idle',
    pinned: false,
    archived: false,
    takeover: true,
    unread: false,
    updatedSeq: 1,
    connectorStatus: 'online',
    agentDefinition: null,
  }
  let created = false,
    snapshotCount = 0,
    connections = 0
  const submissions: Record<string, unknown>[] = []
  let release!: () => void
  let gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/sessions**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname
    if (path.endsWith('/create-and-start')) {
      submissions.push(request.postDataJSON() as Record<string, unknown>)
      created = true
      return route.fulfill({ json: { session } })
    }
    if (path.endsWith('/runtime/messages')) {
      submissions.push(request.postDataJSON() as Record<string, unknown>)
      return route.fulfill({ json: { accepted: true } })
    }
    if (path === '/api/sessions' || path === '/api/sessions/list')
      return route.fulfill({
        json: { sessions: created ? [session] : [], nextCursor: null },
      })
    if (path.endsWith('/snapshot')) {
      snapshotCount++
      await gate
      const value: SessionSnapshot = {
        session,
        state:
          snapshotCount === 1
            ? {}
            : {
                selections: {
                  model: 'opaque-platform',
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
      return route.fulfill({ json: value })
    }
    if (path.endsWith('/agent-binding'))
      return route.fulfill({
        json: { agentDefinition: null, bindingVersion: 0 },
      })
    return route.fulfill({ json: {} })
  })
  await page.route('**/api/ws-ticket', (route) =>
    route.fulfill({ json: { ticket: 'synthetic' } }),
  )
  await page.routeWebSocket('**/api/sessions/*/ws*', () => {
    connections++
  })
  await page.route('**/catalogs/model', (route) =>
    route.fulfill({
      json: {
        models: [
          {
            id: 'personal',
            displayName: '同名模型',
            selectionId: 'opaque-personal',
            enabled: true,
            metadata: { source: 'personal', providerName: '自有连接' },
          },
          {
            id: 'platform',
            displayName: '同名模型',
            selectionId: 'opaque-platform',
            enabled: true,
            default: true,
            metadata: { source: 'platform', providerName: '共享连接' },
          },
        ],
      },
    }),
  )
  await page.route('**/catalogs/permission', (route) =>
    route.fulfill({
      json: {
        permissions: [
          {
            id: 'permission',
            displayName: '配置权限',
            selectionId: 'opaque-permission',
            enabled: true,
            default: true,
          },
        ],
      },
    }),
  )
  await page.goto('/#/login')
  await page.getByLabel('用户名或邮箱').fill('admin')
  await page.getByLabel('密码', { exact: true }).fill('Synthetic-password!')
  await page.getByRole('button', { name: '登录 ↵', exact: true }).click()
  await expect(page.locator('[data-console-shell]')).toBeVisible()
  await page.goto('/#/workspace')
  const model = page.locator('.composer .runtime-model-select')
  const permission = page.locator('.composer .runtime-permission-select')
  await expect(model).toContainText('同名模型')
  await expect(permission).toContainText('配置权限')
  await model.click()
  const choices = page.locator(
    '.composer-model-menu:visible .el-select-dropdown__item',
  )
  await expect(choices).toHaveCount(2)
  await expect(choices.first()).toContainText('默认')
  await expect(choices.first()).toContainText('平台配置 · 共享连接')
  await expect(choices.last()).toContainText('个人配置 · 自有连接')
  await page.screenshot({
    path: info.outputPath('model-menu.png'),
    animations: 'disabled',
  })
  await page.keyboard.press('Escape')
  await page.getByLabel('任务草稿').fill('第一次提问')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect.poll(() => snapshotCount).toBe(1)
  await expect(model).toContainText('同名模型')
  await expect(permission).toContainText('配置权限')
  release()
  await expect(page).toHaveURL(/synthetic-flow/)
  await expect(page.getByLabel('任务草稿')).toBeEnabled()
  await expect(model).toContainText('同名模型')
  await expect(permission).toContainText('配置权限')
  await expect.poll(() => connections).toBe(1)
  gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.getByLabel('任务草稿').fill('继续提问')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect.poll(() => snapshotCount).toBe(2)
  // 旧实现此时 snapshot=null，模型／权限清空且接管与停止状态被卸载。
  await expect(model).toContainText('同名模型')
  await expect(permission).toContainText('配置权限')
  await expect(page.locator('.composer .el-switch')).toBeVisible()
  expect(connections).toBe(1)
  release()
  await expect(page.getByLabel('任务草稿')).toBeEnabled()
  await expect(
    page.getByRole('button', { name: '发送', exact: true }),
  ).not.toHaveClass(/is-loading/)
  expect(submissions).toHaveLength(2)
  expect(submissions[1]!.selections).toEqual({
    model: 'opaque-platform',
    permission: 'opaque-permission',
  })
  expect(connections).toBe(1)
  await page.screenshot({
    path: info.outputPath('after-continuation.png'),
    animations: 'disabled',
  })
})
