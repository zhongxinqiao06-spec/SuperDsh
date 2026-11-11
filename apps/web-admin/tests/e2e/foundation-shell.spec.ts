import { expect, test, type Page } from '@playwright/test'
import { installFoundationFixture } from './foundation-fixture'

async function login(page: Page) {
  await page.goto('/#/login')
  await page.getByLabel('用户名或邮箱').fill('admin')
  await page.getByLabel('密码', { exact: true }).fill('Synthetic-password!')
  await page.getByRole('button', { name: '登录 ↵', exact: true }).click()
  await expect(page.locator('[data-console-shell]')).toBeVisible()
}

test('官网进入登录，后台用户CRUD失败保稿，不准备DSH', async ({ page }) => {
  const state = await installFoundationFixture(page)
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('AI 能力')
  await login(page)
  await page
    .getByRole('navigation')
    .getByRole('link', { name: '用户管理' })
    .click()
  await expect(page.getByRole('cell', { name: /合成成员/ })).toBeVisible()
  await page.getByRole('button', { name: '创建用户', exact: true }).click()
  const editor = page.getByRole('dialog')
  await editor.getByLabel('用户名', { exact: true }).fill('created-user')
  await editor.getByLabel('显示名称').fill('新增合成用户')
  await editor.getByLabel('初始密码').fill('Synthetic-password!')
  await editor.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('cell', { name: /新增合成用户/ })).toBeVisible()
  state.userConflict = true
  await page
    .getByRole('row', { name: /新增合成用户/ })
    .getByRole('button', { name: '编辑' })
    .click()
  await editor.getByLabel('显示名称').fill('冲突草稿保留')
  await editor.getByRole('button', { name: '保存', exact: true }).click()
  await expect(editor.getByText('用户已被修改，请重新加载')).toBeVisible()
  await expect(editor.getByLabel('显示名称')).toHaveValue('冲突草稿保留')
  expect(
    state.requests.filter((entry) => entry.includes('server-agent')),
  ).toEqual([])
})

test('角色权限阻止直接路由挂载，未知入口显示404', async ({ page }) => {
  const state = await installFoundationFixture(page, ['users.read'])
  await login(page)
  await page.goto('/#/access/roles')
  await expect(page.getByText('403', { exact: true })).toBeVisible()
  expect(state.requests).not.toContain('GET /admin/roles')
  await page.goto('/#/does-not-exist')
  await expect(page.getByText('404', { exact: true })).toBeVisible()
})

test('菜单409保留草稿，重新加载可恢复服务端最新配置', async ({ page }) => {
  const state = await installFoundationFixture(page)
  await login(page)
  await page.goto('/#/access/menus')
  await page
    .getByRole('row', { name: /总览 一级页面/ })
    .getByRole('button', { name: '编辑' })
    .click()
  const editor = page.getByRole('dialog')
  await editor.getByLabel('名称', { exact: true }).fill('我的总览')
  state.menuVersion++
  await editor.getByRole('button', { name: '保存', exact: true }).click()
  await expect(editor.getByText('菜单版本冲突，请重新加载')).toBeVisible()
  await expect(editor.getByLabel('名称', { exact: true })).toHaveValue(
    '我的总览',
  )
  await editor.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('button', { name: '重新加载最新配置' }).click()
  await expect(
    page.getByRole('cell', { name: '总览', exact: true }),
  ).toBeVisible()
})

test('工作台按需准备一次、切模块保草稿、退出清理账号状态', async ({ page }) => {
  const state = await installFoundationFixture(page)
  await login(page)
  await page
    .getByRole('navigation')
    .getByRole('link', { name: 'Agent 工作台' })
    .click()
  await expect(page.getByRole('status')).toContainText('已就绪')
  await page.getByLabel('任务草稿').fill('跨模块保留的草稿')
  await page
    .getByRole('navigation')
    .getByRole('link', { name: '总览', exact: true })
    .click()
  await page
    .getByRole('navigation')
    .getByRole('link', { name: 'Agent 工作台' })
    .click()
  await expect(page.getByLabel('任务草稿')).toHaveValue('跨模块保留的草稿')
  expect(
    state.requests.filter((entry) => entry === 'POST /server-agent'),
  ).toHaveLength(1)
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await page.getByRole('button', { name: '确认退出', exact: true }).click()
  await login(page)
  await page
    .getByRole('navigation')
    .getByRole('link', { name: 'Agent 工作台' })
    .click()
  await expect(page.getByLabel('任务草稿')).toHaveValue('')
})

test('语言主题保存，窄屏导航切换后关闭且内容不横向溢出', async ({
  page,
}, testInfo) => {
  await installFoundationFixture(page)
  await login(page)
  await page.goto('/#/account/appearance')
  await page.getByRole('combobox').press('Enter')
  await page.getByRole('option', { name: 'English', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Appearance and language', exact: true }),
  ).toBeVisible()
  await page.getByRole('radio', { name: /Dark$/ }).press('Space')
  await expect(page.locator('html')).toHaveClass('dark')
  await page.reload()
  await expect(page.locator('html')).toHaveClass('dark')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await page.setViewportSize({ width: 390, height: 844 })
  await page
    .getByRole('button', { name: 'Open navigation', exact: true })
    .click()
  await page
    .getByRole('navigation')
    .getByRole('link', { name: 'Users', exact: true })
    .click()
  await expect(
    page.getByRole('heading', { name: 'Users', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('navigation', { name: 'Platform navigation' }),
  ).toBeHidden()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('mobile-users-dark.png') })
})
