import { expect, test, type Page } from '@playwright/test'
import { installParityFixture } from '../parity/ui-fixture'

/** 合成传输明确实现写契约，填充设备、项目和不同分组的会话，不以空列表代替交互。 */
async function workspaceFixture(page: Page, permissions?: string[]) {
  const state = await installParityFixture(page, { permissions })
  const seen: string[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path.startsWith('/api/')) seen.push(`${request.method()} ${path}`)
  })
  const project = {
    id: 'team-project',
    connectorId: 'personal-device',
    name: '团队项目',
    workspacePath: '/team',
    manuallyCreated: true,
    pinned: false,
    activeSessionCount: 1,
  }
  const base = {
    connectorId: 'personal-device',
    projectId: null,
    runtimeId: 'dsh',
    runtime: 'dsh',
    cwd: '/team',
    status: 'idle',
    pinned: false,
    archived: false,
    takeover: true,
    unread: true,
    updatedSeq: 1,
    agentDefinition: null,
  }
  let sessions = [
    {
      ...base,
      id: 'team-session',
      projectId: 'team-project',
      title: '项目会话',
    },
    {
      ...base,
      id: 'server-session',
      connectorId: 'parity-device',
      title: '服务端会话',
    },
    { ...base, id: 'pinned-session', title: '置顶会话', pinned: true },
    { ...base, id: 'loose-session', title: '未分组会话示例' },
  ]
  const writes: { method: string; path: string; body: unknown }[] = []
  await page.route('**/api/connectors', (route) =>
    route.fulfill({
      json: {
        connectors: [
          {
            id: 'parity-device',
            name: '服务设备',
            executorKind: 'server-agent',
            status: 'online',
          },
          {
            id: 'personal-device',
            name: '团队电脑',
            executorKind: 'desktop',
            status: 'online',
          },
        ],
      },
    }),
  )
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'GET') {
      writes.push({
        method: route.request().method(),
        path: '/projects',
        body: route.request().postDataJSON(),
      })
      return route.fulfill({ status: 409, json: { detail: '合成项目冲突' } })
    }
    return route.fulfill({ json: { projects: [project] } })
  })
  await page.route(
    (url) => /^\/api\/sessions(?:\/list)?$/.test(url.pathname),
    (route) => {
      const url = new URL(route.request().url()),
        archived = url.searchParams.get('archived') === 'true'
      return route.fulfill({
        json: {
          sessions: url.pathname.endsWith('/list')
            ? sessions
            : sessions.filter((item) => item.archived === archived),
          nextCursor: null,
        },
      })
    },
  )
  await page.route('**/api/sessions/read', async (route) => {
    const body: unknown = route.request().postDataJSON()
    expect(Array.isArray(body)).toBe(true)
    writes.push({
      method: route.request().method(),
      path: '/sessions/read',
      body,
    })
    sessions = sessions.map((item) =>
      Array.isArray(body) && body.includes(item.id)
        ? { ...item, unread: false }
        : item,
    )
    return route.fulfill({
      json: { sessions, serverTime: '2026-11-01T00:00:00Z' },
    })
  })
  await page.route(
    '**/api/projects/team-project/sessions/archive-all',
    async (route) => {
      const body = route.request().postDataJSON() as {
        archived: boolean
        scope: string
      }
      expect(body.scope).toBe('all')
      writes.push({
        method: route.request().method(),
        path: '/projects/team-project/sessions/archive-all',
        body,
      })
      sessions = sessions.map((item) =>
        item.projectId === project.id
          ? { ...item, archived: body.archived }
          : item,
      )
      return route.fulfill({
        json: { sessions, updatedCount: 1, skippedCount: 0 },
      })
    },
  )
  return { state, writes, seen }
}

test('填充侧栏按设备、置顶、项目和服务器分组，已读数组精确提交', async ({
  page,
}) => {
  const fixture = await workspaceFixture(page)
  await page.goto('/#/workspace')
  const sidebar = page.locator('.workspace-sidebar')
  await expect(
    sidebar.getByRole('button', { name: '团队电脑', exact: true }),
  ).toBeVisible()
  await expect(sidebar.getByText('置顶会话', { exact: true })).toBeVisible()
  await sidebar.getByRole('button', { name: '团队项目', exact: true }).click()
  await expect(sidebar.getByText('项目会话', { exact: true })).toBeVisible()
  await expect(sidebar.getByText('服务端会话', { exact: true })).toBeVisible()
  await sidebar.getByRole('button', { name: '全部标为已读' }).first().click()
  await expect
    .poll(() =>
      fixture.writes.filter((entry) => entry.path === '/sessions/read'),
    )
    .toHaveLength(1)
  expect(fixture.writes[0]?.body).toEqual([
    'team-session',
    'server-session',
    'pinned-session',
    'loose-session',
  ])
  await expect(sidebar.getByText(/· 未读/)).toHaveCount(0)
})

test('项目批量归档和恢复等待确认，使用旧 scope 与 archived 语义', async ({
  page,
}) => {
  const fixture = await workspaceFixture(page)
  await page.goto('/#/workspace')
  const row = page.locator('.sidebar-project').filter({ hasText: '团队项目' })

  await row.getByRole('button', { name: '归档全部会话' }).click()
  await page
    .locator('.el-message-box')
    .getByRole('button', { name: '取消' })
    .click()
  expect(fixture.writes).toEqual([])

  await row.getByRole('button', { name: '归档全部会话' }).click()
  await page
    .locator('.el-message-box')
    .getByRole('button', { name: /确认|确定/ })
    .click()
  await expect.poll(() => fixture.writes.length).toBe(1)
  expect(fixture.writes[0]?.body).toEqual({ archived: true, scope: 'all' })

  await row.getByRole('button', { name: '恢复全部会话' }).click()
  await page
    .locator('.el-message-box')
    .getByRole('button', { name: /确认|确定/ })
    .click()
  await expect.poll(() => fixture.writes.length).toBe(2)
  expect(fixture.writes[1]?.body).toEqual({ archived: false, scope: 'all' })
})

test('项目取消不写入，空草稿与服务端冲突保留弹窗', async ({ page }) => {
  const fixture = await workspaceFixture(page)
  await page.goto('/#/workspace')
  await page.getByRole('button', { name: '新建项目', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: '新建项目', exact: true })
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(
    dialog.getByText('请选择设备并填写项目名称与工作目录'),
  ).toBeVisible()
  expect(fixture.writes).toEqual([])
  await dialog.getByRole('textbox', { name: '项目名称' }).fill('未保存的名称')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('button', { name: '新建项目', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '新建项目', exact: true })
  await expect(dialog.getByRole('textbox', { name: '项目名称' })).toHaveValue(
    '',
  )
  await dialog.getByRole('textbox', { name: '项目名称' }).fill('合成项目')
  await dialog
    .getByRole('textbox', { name: '项目工作目录' })
    .fill('/synthetic/new')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog.getByText('合成项目冲突')).toBeVisible()
  await expect(dialog.getByRole('textbox', { name: '项目名称' })).toHaveValue(
    '合成项目',
  )
  expect(fixture.writes).toHaveLength(1)
})

test('仅有会话读取权限不请求设备项目目录或启动引擎', async ({ page }) => {
  const fixture = await workspaceFixture(page, ['sessions.read'])
  await page.goto('/#/workspace')
  await expect(page.getByRole('textbox', { name: '任务草稿' })).toBeDisabled()
  await expect(
    page
      .locator('.workspace-sidebar')
      .getByRole('button', { name: '新会话', exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: '新建项目', exact: true }),
  ).toHaveCount(0)
  expect(
    fixture.seen.some((value) =>
      ['/api/connectors', '/api/projects', '/api/server-agent'].some((path) =>
        value.endsWith(path),
      ),
    ),
  ).toBe(false)
})

test('仅执行权限使用 prepare 受管项目，缺失项目保留草稿且不上传或创建', async ({
  page,
}) => {
  const fixture = await workspaceFixture(page, ['sessions.run', 'models.use'])
  const created: Record<string, unknown>[] = []
  await page.route('**/api/sessions/create-and-start', (route) => {
    created.push(route.request().postDataJSON())
    return route.fulfill({
      status: 409,
      json: { detail: '合成创建冲突，保留草稿' },
    })
  })
  await page.goto('/#/workspace')
  await expect(
    page.getByRole('status').filter({ hasText: '已就绪' }),
  ).toBeVisible()
  const input = page.getByRole('textbox', { name: '任务草稿' })
  await input.fill('合成项目绑定任务')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect.poll(() => created.length).toBe(1)
  expect(created[0]).toEqual(
    expect.objectContaining({
      connectorId: 'parity-device',
      projectId: 'parity-project',
      runtimeId: 'dsh',
    }),
  )
  expect(created[0]).not.toHaveProperty('cwd')
  expect(
    fixture.seen.some(
      (path) =>
        path.endsWith('/api/projects') || path.endsWith('/api/connectors'),
    ),
  ).toBe(false)
  await expect(input).toHaveValue('合成项目绑定任务')
  await page.route('**/api/server-agent', (route) =>
    route.fulfill({
      json: {
        agent: {
          status: 'running',
          connectorId: 'parity-device',
          projectId: null,
          runtimeId: 'dsh',
          error: null,
        },
      },
    }),
  )
  await page.reload()
  // 页面重载创建新的内存草稿；这里只验证缺失项目的发送守卫，不声称刷新后持久保存。
  await input.fill('合成项目绑定任务')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(
    page.getByText('请先在设备下选择有效项目；尚无项目时请先创建项目。', {
      exact: true,
    }),
  ).toBeVisible()
  expect(created).toHaveLength(1)
  await expect(input).toHaveValue('合成项目绑定任务')
})
