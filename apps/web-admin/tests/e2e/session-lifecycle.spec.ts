import { expect, test } from '@playwright/test'
import { installFoundationFixture } from './foundation-fixture'
import type {
  SessionSnapshot,
  WorkspaceSession,
} from '../../fronted/src/types/workbench/models'

/** 浏览器完整操作回归：模拟接口延迟停止，不把受理响应当成执行完成。 */
test('历史会话取消删除、运行拒删、终止确认与删除后刷新', async ({
  page,
}, info) => {
  const fixture = await installFoundationFixture(page, [
    'menus.read',
    'devices.read',
    'devices.manage',
    'sessions.read',
    'sessions.run',
    'models.use',
  ])
  fixture.agentStatus = 'running'
  let deleted = false,
    interrupted = false,
    observations = 0,
    interrupts = 0
  const session: WorkspaceSession = {
    id: 'synthetic-lifecycle',
    connectorId: 'connector',
    executorKind: 'server-agent',
    projectId: null,
    runtime: 'dsh',
    runtimeId: 'dsh',
    title: '生命周期合成会话',
    cwd: '/synthetic',
    status: 'running',
    pinned: false,
    archived: false,
    takeover: true,
    unread: false,
    updatedSeq: 1,
    connectorStatus: 'online',
    agentDefinition: null,
  }
  await page.route('**/api/sessions**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/sessions' || path === '/api/sessions/list')
      return route.fulfill({
        json: { sessions: deleted ? [] : [session], nextCursor: null },
      })
    if (path.endsWith('/agent-binding'))
      return route.fulfill({
        json: { agentDefinition: null, bindingVersion: 0 },
      })
    if (route.request().method() === 'DELETE') {
      if (session.status === 'running')
        return route.fulfill({
          status: 409,
          json: { detail: '请先终止任务，确认停止后再删除会话' },
        })
      deleted = true
      return route.fulfill({ json: { deleted: true } })
    }
    if (path.endsWith('/interrupt')) {
      interrupted = true
      interrupts++
      return route.fulfill({ json: { accepted: true } })
    }
    if (path.endsWith('/snapshot')) {
      if (interrupted && ++observations >= 3) session.status = 'idle'
      const snapshot: SessionSnapshot = {
        session,
        state: {},
        timeline: { items: [], nextSeq: null, hasMore: false },
        notices: [],
        approvals: [],
        effectiveCapabilities: {},
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
  await page.goto('/#/login')
  await page.getByLabel('用户名或邮箱').fill('admin')
  await page.getByLabel('密码', { exact: true }).fill('Synthetic-password!')
  await page.getByRole('button', { name: '登录 ↵', exact: true }).click()
  await expect(page.locator('[data-console-shell]')).toBeVisible()
  await page.goto('/#/workspace')
  const item = page
    .locator('.sidebar-session')
    .filter({ hasText: session.title })
  const actions = item.getByRole('button', { name: '会话操作' })
  await actions.focus()
  await actions.press('Enter')
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem')).toHaveText([
    '重命名',
    '置顶',
    '归档',
    '删除',
  ])
  await expect(page).toHaveURL(/#\/workspace$/)
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(actions).toBeFocused()
  await item.locator('.session-main').click()
  await expect(page).toHaveURL(/synthetic-lifecycle/)
  async function openDelete() {
    await actions.click()
    await menu.getByRole('menuitem', { name: '删除', exact: true }).click()
    return page.getByRole('dialog', { name: '删除会话' })
  }
  await (
    await openDelete()
  )
    .getByRole('button', { name: '取消', exact: true })
    .click()
  await expect(item).toBeVisible()
  await (
    await openDelete()
  )
    .getByRole('button', { name: '删除', exact: true })
    .click()
  await expect(page.getByRole('alert')).toContainText('请先终止任务')
  await expect(item).toBeVisible()
  await page.getByRole('button', { name: '中断任务', exact: true }).click()
  await expect(
    page.getByRole('button', { name: '中断任务', exact: true }),
  ).toBeDisabled()
  await expect(item).toContainText('idle')
  await expect(page.getByLabel('任务草稿')).toBeEnabled()
  expect(interrupts).toBe(1)
  await page.screenshot({
    path: info.outputPath('confirmed-stopped.png'),
    animations: 'disabled',
  })
  await (
    await openDelete()
  )
    .getByRole('button', { name: '删除', exact: true })
    .click()
  await expect(page).toHaveURL(/#\/workspace$/)
  await expect(item).toHaveCount(0)
  await page.reload()
  await expect(page.locator('.composer')).toBeVisible()
  await expect(item).toHaveCount(0)
  expect(deleted).toBe(true)
})
