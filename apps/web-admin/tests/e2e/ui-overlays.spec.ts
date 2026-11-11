import { expect, test, type Page, type Locator } from '@playwright/test'
import { installParityFixture } from '../parity/ui-fixture'

/** 公共浮层只用合成接口；打开与取消不产生真实配置写入。 */
const editors = [
  ['/access/users', '创建用户', '创建用户'],
  ['/access/roles', '创建角色', '新增角色'],
  ['/access/roles', '查看权限', '查看权限'],
  ['/access/menus', '新增分组', '编辑菜单项'],
  ['/knowledge', '新增知识库', '新增知识库'],
  ['/skills', '新增技能', '新增技能'],
  ['/tools', '新增工具', '新增工具'],
  ['/models', '新增配置', '模型能力配置'],
  ['/models/multimodal', '新增配置', '模型能力配置'],
  ['/system/storage', '新增连接', '存储连接'],
  ['/system/storage', '策略与默认存储', '文件策略'],
  ['/system/service', '编辑配置', '访问'],
  ['/system/service', '编辑公告', '编辑公告'],
  ['/account/security', '重置密码', '修改密码'],
] as const

async function checkDialog(dialog: Locator, page: Page) {
  await expect(dialog).toBeVisible()
  await expect(page.locator('.dialog-fade-enter-active')).toHaveCount(0)
  const panel = dialog.locator('.el-dialog')
  const header = panel.locator('.el-dialog__header')
  const footer = panel.locator('.el-dialog__footer')
  await expect(panel).toHaveCSS('overflow-y', 'hidden')
  const bounds = await panel.boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(-1)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(
    page.viewportSize()!.width + 1,
  )
  const headerBounds = await header.boundingBox()
  const footerBounds = await footer.boundingBox()
  const primary = footer.locator('.el-button--primary')
  const cancel = footer.getByRole('button', { name: '取消', exact: true })
  if (await primary.count()) {
    expect((await primary.boundingBox())!.x).toBeGreaterThan(
      (await cancel.boundingBox())!.x,
    )
  }
  if (page.viewportSize()!.width === 390)
    await expect(panel).toHaveCSS('width', '390px')
  expect(headerBounds!.y).toBeGreaterThanOrEqual(-1)
  expect(footerBounds!.y + footerBounds!.height).toBeLessThanOrEqual(
    page.viewportSize()!.height + 1,
  )
  await panel.locator('.el-dialog__body').evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  expect((await header.boundingBox())!.y).toBe(headerBounds!.y)
  expect((await footer.boundingBox())!.y).toBe(footerBounds!.y)
  const close = dialog.getByRole('button', {
    name: '关闭此对话框',
    exact: true,
  })
  await close.focus()
  await page.keyboard.press('Shift+Tab')
  expect(
    await dialog.evaluate((element) =>
      element.contains(document.activeElement),
    ),
  ).toBe(true)
}

for (const theme of ['light', 'dark']) {
  test(`公共编辑弹窗 ${theme}：桌面与窄屏底栏、只读权限和焦点约束`, async ({
    page,
  }, info) => {
    test.setTimeout(120_000)
    await page.addInitScript(
      (value) => localStorage.setItem('starbridge.theme', value),
      theme,
    )
    const state = await installParityFixture(page)
    for (const [path, trigger, title] of editors) {
      await page.goto(`/#${path}`)
      await expect(page.locator('.resource-loading')).toHaveCount(0)
      await page
        .getByRole('button', { name: trigger, exact: true })
        .first()
        .click()
      const dialog = page.getByRole('dialog', { name: title, exact: true })
      for (const width of [1440, 390]) {
        await page.setViewportSize({
          width,
          height: width === 390 ? 844 : 1000,
        })
        await checkDialog(dialog, page)
      }
      if (title === '查看权限') {
        await expect(
          dialog.getByRole('button', { name: '保存', exact: true }),
        ).toHaveCount(0)
        await expect(dialog.getByRole('textbox').first()).toBeDisabled()
      }
      if (['新增知识库', '文件策略', '修改密码'].includes(title)) {
        await page.screenshot({
          path: info.outputPath(`${title}-${theme}-390.png`),
          animations: 'disabled',
        })
      }
      await dialog
        .getByRole('button', { name: '关闭此对话框', exact: true })
        .click()
      await expect(dialog).toBeHidden()
      await page.setViewportSize({ width: 1440, height: 1000 })
    }
    expect(state.missing).toEqual([])
    expect(
      state.requests.filter(
        (request) =>
          /^(POST|PUT|PATCH|DELETE) /u.test(request) &&
          !request.includes('/auth/refresh') &&
          request !== 'POST /admin/agents/initialize',
      ),
    ).toEqual([])
  })

  test(`外围页面 ${theme}：官网、登录、隐私与不存在页面`, async ({
    page,
  }, info) => {
    await page.addInitScript(
      (value) => localStorage.setItem('starbridge.theme', value),
      theme,
    )
    const state = await installParityFixture(page, { signedIn: false })
    for (const path of ['/', '/login', '/privacy', '/not-a-route']) {
      await page.goto(`/#${path}`)
      if (path === '/not-a-route')
        await expect(page.getByText('404', { exact: true })).toBeVisible()
      else await expect(page.locator('h1')).toHaveCount(1)
      for (const width of [1440, 390]) {
        await page.setViewportSize({
          width,
          height: width === 390 ? 844 : 1000,
        })
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true)
        if (path === '/' && width === 390) {
          const navigation = page.getByRole('navigation', {
            name: '官网导航',
            exact: true,
          })
          await expect(navigation).toBeHidden()
          await page
            .getByRole('button', { name: '打开导航', exact: true })
            .click()
          await expect(
            navigation.getByRole('link', { name: '产品能力', exact: true }),
          ).toBeVisible()
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true)
          await page.keyboard.press('Escape')
          await expect(navigation).toBeHidden()
        }
        if (path === '/login')
          await page.screenshot({
            path: info.outputPath(`login-${theme}-${width}.png`),
            animations: 'disabled',
          })
      }
    }
    expect(state.missing).toEqual([])
  })
}

test('资源加载失败保留重试入口，不显示成功空态', async ({ page }) => {
  await installParityFixture(page, { state: 'error' })
  await page.goto('/#/knowledge')
  await expect(
    page.getByRole('button', { name: '重试', exact: true }).first(),
  ).toBeVisible()
  await expect(page.getByText('暂无知识库。', { exact: true })).toHaveCount(0)
})
