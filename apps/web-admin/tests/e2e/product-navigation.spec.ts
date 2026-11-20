import { expect, test, type Page } from '@playwright/test'
import { installFoundationFixture } from './foundation-fixture'

const workspaces = ['products.office', 'products.entertainment']
const sidebar = (page: Page) =>
  page.getByRole('navigation', { name: '平台导航' })
const heading = (page: Page, name: string) =>
  page.getByRole('heading', { name, exact: true })
const radio = (page: Page, name: string) =>
  page
    .getByRole('radiogroup', { name: '菜单所属产品' })
    .getByRole('radio', { name, exact: true })

test('新增菜单分组保存符合后端约束的稳定标识', async ({ page }) => {
  const state = await installFoundationFixture(page)
  state.signedIn = true
  await page.goto('/#/access/menus')
  await page.getByRole('button', { name: '新增分组' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('名称', { exact: true }).fill('新分组')
  const saved = page.waitForRequest(
    (request) =>
      request.method() === 'PUT' &&
      new URL(request.url()).pathname.endsWith('/admin/menus'),
  )
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  const body = (await saved).postDataJSON()
  const group = body.items.find(
    (item: { title: string }) => item.title === '新分组',
  )
  expect(group.id).toMatch(/^group-[a-z0-9-]+$/)
  await expect(dialog).toBeHidden()
})

test('办公管理员的产品成员和模型变更仅发送到办公接口', async ({ page }) => {
  const identity = await installFoundationFixture(page, [
    ...workspaces,
    'products.office.members.manage',
    'products.office.models.manage',
  ])
  identity.signedIn = true
  let joined = false
  const member = {
    userId: 'member-1',
    username: 'test-member',
    displayName: '测试成员',
    roleIds: ['member'],
    removable: true,
    revision: 7,
  }
  await page.route(
    /\/api\/products\/office\/members(?:[/?]|$)/,
    async (route) => {
      const method = route.request().method()
      if (method === 'POST') {
        expect(route.request().postDataJSON()).toEqual({
          identifier: member.username,
        })
        joined = true
        return route.fulfill({ json: member })
      }
      if (method === 'DELETE') {
        expect(
          new URL(route.request().url()).searchParams.get('revision'),
        ).toBe('7')
        joined = false
        return route.fulfill({ status: 204 })
      }
      return route.fulfill({
        json: {
          items: joined ? [member] : [],
          total: joined ? 1 : 0,
          page: 1,
          pageSize: 10,
        },
      })
    },
  )
  let chosen: string | null = null
  await page.route(
    /\/api\/admin\/products\/office\/model-defaults(?:\/chat)?$/,
    async (route) => {
      if (route.request().method() === 'PUT') {
        chosen = route.request().postDataJSON().configurationId
        return route.fulfill({ json: { configurationId: chosen } })
      }
      return route.fulfill({
        json: {
          configurations: [
            {
              id: 'cfg-1',
              capability: 'chat',
              name: '已授权模型',
              modelId: 'configured',
            },
          ],
          defaults: [],
          overrides: chosen ? { chat: chosen } : {},
        },
      })
    },
  )
  await page.goto('/#/product/members')
  await page.getByRole('button', { name: '添加成员' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('现有账号的用户名或邮箱').fill(member.username)
  await dialog.getByRole('button', { name: '添加', exact: true }).click()
  const row = page.getByRole('row', { name: /test-member/ })
  await expect(row).toContainText('办公用户')
  await row.getByRole('button', { name: '移除成员' }).click()
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  expect(joined).toBe(true)
  await row.getByRole('button', { name: '移除成员' }).click()
  await dialog.getByRole('button', { name: '确认移除' }).click()
  await expect(row).toHaveCount(0)
  await page.goto('/#/product/defaults')
  await page.getByRole('button', { name: '选择模型' }).click()
  await dialog.getByRole('combobox').press('Enter')
  await page.getByRole('option', { name: /已授权模型/ }).click()
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('row', { name: /本产品配置/ })).toContainText(
    '已授权模型',
  )
  expect(chosen).toBe('cfg-1')
  await page.goto('/#/product/defaults?product=entertainment')
  await expect(page.getByText('403', { exact: true })).toBeVisible()
  expect(identity.requests).not.toContain(
    'GET /admin/products/entertainment/model-defaults',
  )
  await page.goto('/#/product/members?product=entertainment')
  await expect(page.getByText('403', { exact: true })).toBeVisible()
  expect(identity.requests).not.toContain('GET /products/entertainment/members')
})

test('菜单角色预览展示服务端为所选角色计算的有效树', async ({ page }) => {
  const identity = await installFoundationFixture(page, [
    ...workspaces,
    'menus.manage',
  ])
  identity.signedIn = true
  await page.route(/\/api\/admin\/menus\/preview\?/, (route) => {
    const query = new URL(route.request().url()).searchParams
    const title =
      query.get('roleId') === 'member' ? '成员可见项目' : '管理员可见项目'
    return route.fulfill({
      json: {
        version: 2,
        items: [
          { id: 'group', kind: 'group', parentId: null, title: '预览业务组' },
          { id: 'page', kind: 'page', parentId: 'group', title },
        ],
      },
    })
  })
  await page.goto('/#/access/menus')
  await page.getByRole('button', { name: '角色预览' }).click()
  const dialog = page.getByRole('dialog', { name: '角色预览' })
  await expect(dialog.getByText('成员可见项目')).toBeVisible()
  await dialog.getByRole('combobox').press('Enter')
  await page.getByRole('option', { name: '平台超管' }).click()
  await expect(dialog.getByText('管理员可见项目')).toBeVisible()
  await expect(dialog.getByText('成员可见项目')).toHaveCount(0)
})

/** 从管理表格编辑名称，用可见菜单与版本验证已写入所选产品。 */
async function rename(page: Page, from: string, to: string) {
  const row = page
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: from, exact: true }) })
  await row.getByRole('button', { name: '编辑', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '编辑菜单项' })
  await dialog.getByLabel('名称', { exact: true }).fill(to)
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('cell', { name: to, exact: true })).toBeVisible()
}

test('同一登录可切换工作台，娱乐的共享管理和账号链接在刷新后保留产品', async ({
  page,
}) => {
  const state = await installFoundationFixture(page, [
    ...workspaces,
    'users.read',
    'sessions.read',
    'studio.projects.read',
    'studio.assets.read',
  ])
  state.signedIn = true
  await page.goto('/#/products')
  await page.getByRole('link', { name: /星桥娱乐/ }).click()
  const nav = sidebar(page)
  for (const [name, title] of [
    ['首页', '创作中心'],
    ['作品项目', '我的作品'],
    ['素材库', '媒体库'],
    ['制作任务', '制作任务'],
  ] as const) {
    const item = nav.getByRole('link', { name, exact: true })
    await item.click()
    await expect(heading(page, title)).toBeVisible()
    await expect(item).toHaveAttribute('aria-current', 'page')
  }
  await expect(nav.getByRole('link', { name: '智能对话' })).toHaveCount(0)
  await nav.getByRole('button', { name: '用户与权限' }).click()
  await expect(page.locator('.console-sidebar')).toHaveCSS('width', '248px')
  const groupBounds = await nav
    .getByRole('button', { name: '用户与权限' })
    .boundingBox()
  const childBounds = await nav
    .getByRole('link', { name: '账号与角色' })
    .boundingBox()
  expect(childBounds!.x - groupBounds!.x).toBe(20)
  await nav.getByRole('link', { name: '账号与角色' }).click()
  await expect(page).toHaveURL(/#\/access\/users\?product=entertainment$/)
  await expect(page.getByRole('cell', { name: /合成成员/ })).toBeVisible()
  await page.reload()
  await expect(
    sidebar(page).getByRole('link', { name: '素材库' }),
  ).toBeVisible()
  await page.getByRole('link', { name: /合成管理员/ }).click()
  await expect(page).toHaveURL(/#\/account\/profile\?product=entertainment$/)
  await expect(heading(page, '个人资料')).toBeVisible()
  await page.reload()
  await expect(nav.getByRole('link', { name: '作品项目' })).toBeVisible()
  await page.getByRole('link', { name: '切换产品' }).click()
  await page.getByRole('link', { name: /星桥办公/ }).click()
  await expect(
    page.getByRole('heading', { name: /今天，想完成什么/ }),
  ).toBeVisible()
  await expect(nav.getByRole('link', { name: '智能对话' })).toBeVisible()
  await expect(nav.getByRole('link', { name: '作品项目' })).toHaveCount(0)
  expect(state.requests).not.toContain('POST /server-agent')
})

test('管理员分别编辑和恢复两套菜单，保存即时反映在对应侧栏', async ({
  page,
}) => {
  const state = await installFoundationFixture(page, [
    ...workspaces,
    'menus.manage',
    'settings.manage',
    'menus.read',
    'studio.projects.read',
    'studio.assets.read',
  ])
  state.signedIn = true
  await page.goto('/#/access/menus?product=entertainment')
  await expect(radio(page, '星桥娱乐')).toBeChecked()
  await rename(page, '作品项目', '我的作品')
  await expect(
    sidebar(page).getByRole('link', { name: '我的作品' }),
  ).toBeVisible()
  await radio(page, '星桥办公').press('Space')
  await expect(page.getByText('配置版本 1', { exact: true })).toBeVisible()
  await rename(page, '平台总览', '运营总览')
  await expect(
    sidebar(page).getByRole('link', { name: '我的作品' }),
  ).toBeVisible()
  await radio(page, '星桥娱乐').press('Space')
  await expect(
    page.getByRole('cell', { name: '我的作品', exact: true }),
  ).toBeVisible()
  await expect(page.getByText('配置版本 2', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '恢复默认', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: '恢复默认菜单' })
  await expect(confirmation).toContainText('确认恢复星桥娱乐的默认菜单布局？')
  await confirmation.getByRole('button', { name: '确认恢复' }).click()
  await expect(
    sidebar(page).getByRole('link', { name: '作品项目' }),
  ).toBeVisible()
  await expect(page.getByText('配置版本 3', { exact: true })).toBeVisible()
  await page.reload()
  await expect(radio(page, '星桥娱乐')).toBeChecked()
  await radio(page, '星桥办公').press('Space')
  await expect(
    page.getByRole('cell', { name: '运营总览', exact: true }),
  ).toBeVisible()
  await expect(page.getByText('配置版本 2', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: '切换产品' }).click()
  await page.getByRole('link', { name: /星桥办公/ }).click()
  await expect(
    sidebar(page).getByRole('link', { name: '运营总览' }),
  ).toBeVisible()
})

test('娱乐单产品账号在窄屏通过抽屉进入三页，拒绝办公工作台和未授权管理页', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const state = await installFoundationFixture(page, [
    'products.entertainment',
    'sessions.read',
    'studio.projects.read',
    'studio.assets.read',
  ])
  state.signedIn = true
  await page.goto('/#/workspace')
  await expect(page).toHaveURL(/#\/entertainment$/)
  for (const [name, title] of [
    ['素材库', '媒体库'],
    ['制作任务', '制作任务'],
    ['作品项目', '我的作品'],
    ['首页', '创作中心'],
  ] as const) {
    await page.getByRole('button', { name: '打开导航' }).click()
    const nav = sidebar(page)
    await expect(nav.locator(':scope > :first-child')).toHaveAccessibleName(
      '首页',
    )
    await expect(nav.getByRole('link', { name: '智能对话' })).toHaveCount(0)
    await expect(nav.getByRole('button', { name: '用户与权限' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: '切换产品' })).toHaveCount(0)
    await nav.getByRole('link', { name, exact: true }).click()
    await expect(heading(page, title)).toBeVisible()
    await expect(nav).toBeHidden()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true)
  }
  await page.goto('/#/access/menus?product=entertainment')
  await expect(page.getByText('403', { exact: true })).toBeVisible()
  expect(state.requests).not.toContain('GET /admin/menus')
  expect(state.requests).not.toContain('POST /server-agent')
})

test('办公只读菜单管理员可以查看娱乐编排，不能写入或直接进入娱乐产品', async ({
  page,
}) => {
  const state = await installFoundationFixture(page, [
    'products.office',
    'menus.read',
  ])
  state.signedIn = true
  await page.goto('/#/access/menus')
  await radio(page, '星桥娱乐').press('Space')
  await expect(
    page.getByRole('cell', { name: '素材库', exact: true }),
  ).toBeVisible()
  for (const action of ['编辑', '新增分组', '恢复默认']) {
    await expect(
      page.getByRole('button', { name: action, exact: true }),
    ).toHaveCount(0)
  }
  await expect(
    sidebar(page).getByRole('link', { name: '作品项目' }),
  ).toHaveCount(0)
  await page.goto('/#/entertainment/library')
  await expect(
    page.getByRole('heading', { name: /今天，想完成什么/ }),
  ).toBeVisible()
  expect(state.requests).not.toContain('GET /studio/library')
  expect(state.requests).not.toContain('PUT /admin/menus')
})
