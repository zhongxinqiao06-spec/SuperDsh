import { expect, test, type Page, type Locator } from '@playwright/test'
import { installParityFixture } from '../parity/ui-fixture'
import { expectControlAppearance } from './control-appearance'
import { captureDesign } from './design-capture'

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

/** 测量实际字段边界，防止样式声明存在但标签、输入框仍然贴合。 */
async function checkFormSpacing(scope: Locator) {
  const spacing = await scope.evaluate((element) => {
    const visible = (node: Element) => node.getClientRects().length > 0
    const labelGaps = [...element.querySelectorAll('label')].flatMap(
      (label) => {
        const control = label.querySelector(
          ':scope > .el-input, :scope > .el-textarea, :scope > .el-select, :scope > .el-input-number',
        )
        const text = [...label.childNodes].find(
          (node) =>
            node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
        )
        if (!control || !text || !visible(control)) return []
        const content = text.textContent ?? ''
        const range = document.createRange()
        range.setStart(text, content.search(/\S/u))
        range.setEnd(text, content.trimEnd().length)
        return [
          {
            label: content.trim(),
            gap:
              control.getBoundingClientRect().top -
              range.getBoundingClientRect().bottom,
          },
        ]
      },
    )
    const fieldGaps = [
      ...element.querySelectorAll(
        'form.stack, .form-stack, .form-section > .stack',
      ),
    ].flatMap((group) => {
      const fields = [...group.children].filter(visible)
      return fields.flatMap((field, index) => {
        const next = fields[index + 1]
        if (!field.matches('.field') || !next?.matches('.field')) return []
        return [
          next.getBoundingClientRect().top -
            field.getBoundingClientRect().bottom,
        ]
      })
    })
    return { labelGaps, fieldGaps }
  })
  for (const { label, gap } of spacing.labelGaps)
    expect(gap, `${label} 标签与输入控件应留出间距`).toBeGreaterThanOrEqual(6)
  for (const gap of spacing.fieldGaps)
    expect(gap, '相邻表单字段应留出组间距').toBeGreaterThanOrEqual(14)
}

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
    const primaryBox = (await primary.boundingBox())!
    const cancelBox = (await cancel.boundingBox())!
    const gap =
      Math.abs(primaryBox.y - cancelBox.y) < 1
        ? primaryBox.x - cancelBox.x - cancelBox.width
        : primaryBox.y - cancelBox.y - cancelBox.height
    expect(
      gap,
      '底栏按钮应有间距，且不能叠加组件默认外边距',
    ).toBeGreaterThanOrEqual(6)
    expect(gap).toBeLessThanOrEqual(12)
  }
  if (page.viewportSize()!.width === 390)
    await expect(panel).toHaveCSS('width', '390px')
  expect(headerBounds!.y).toBeGreaterThanOrEqual(-1)
  expect(footerBounds!.y + footerBounds!.height).toBeLessThanOrEqual(
    page.viewportSize()!.height + 1,
  )
  for (const button of await footer.getByRole('button').all()) {
    const buttonBounds = (await button.boundingBox())!
    expect(buttonBounds.x).toBeGreaterThanOrEqual(footerBounds!.x)
    expect(buttonBounds.x + buttonBounds.width).toBeLessThanOrEqual(
      footerBounds!.x + footerBounds!.width,
    )
  }
  expect(
    await panel
      .locator('.el-dialog__body')
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    '弹窗正文不能横向挤出视口',
  ).toBe(true)
  await checkFormSpacing(panel)
  await expectControlAppearance(panel)
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
  for (const product of ['office', 'entertainment']) {
    test(`公共编辑弹窗 ${product} ${theme}：四档宽度间距、底栏、只读权限和焦点约束`, async ({
      page,
    }, info) => {
      test.setTimeout(150_000)
      await page.addInitScript(
        (value) => localStorage.setItem('starbridge.theme', value),
        theme,
      )
      const state = await installParityFixture(page, { bothProducts: true })
      for (const [path, trigger, title] of editors) {
        await page.goto(`/#${path}?product=${product}`)
        await expect(page.locator('.resource-loading')).toHaveCount(0)
        await page
          .getByRole('button', { name: trigger, exact: true })
          .first()
          .click()
        const dialog = page.getByRole('dialog', { name: title, exact: true })
        for (const width of [1440, 1280, 768, 390]) {
          await page.setViewportSize({
            width,
            height: width === 390 ? 844 : 1000,
          })
          await checkDialog(dialog, page)
          if (width === 1440 || width === 390)
            await captureDesign(
              page,
              `dialog-${editors.findIndex((item) => item[0] === path && item[1] === trigger)}-${product}-${theme}-${width}.png`,
            )
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
  }

  test(`扩展来源间距 ${theme}：页面与弹窗共用布局、四档宽度切换表单`, async ({
    page,
  }, info) => {
    await page.addInitScript(
      (value) => localStorage.setItem('starbridge.theme', value),
      theme,
    )
    const state = await installParityFixture(page)
    await page.route('**/api/admin/extensions', (route) =>
      route.fulfill({
        json: {
          items: ['办公工具', '创作工具'].map((name, index) => ({
            id: `spacing-source-${index}`,
            name,
            kind: 'builtin',
            enabled: true,
            revision: 1,
            activeVersion: 'fixture',
            status: 'ready',
            credentialConfigured: false,
            tools: [],
            versions: [
              { version: 'fixture', digest: 'fixture', createdAt: '' },
            ],
            createdAt: '',
            updatedAt: '',
          })),
        },
      }),
    )
    for (const surface of ['page', 'dialog']) {
      await page.goto(surface === 'page' ? '/#/system/extensions' : '/#/tools')
      if (surface === 'dialog')
        await page
          .getByRole('button', { name: '扩展来源与 MCP', exact: true })
          .click()
      const scope =
        surface === 'page'
          ? page.locator('.management-page')
          : page.getByRole('dialog', { name: '工具来源管理', exact: true })
      await expect(
        scope.getByRole('cell', { name: '办公工具', exact: true }),
      ).toBeVisible()
      await expect(page.locator('.dialog-fade-enter-active')).toHaveCount(0)
      for (const width of [1440, 1280, 768, 390]) {
        await page.setViewportSize({
          width,
          height: width === 390 ? 844 : 1000,
        })
        const installed = scope.getByRole('tabpanel', {
          name: '已安装来源',
          exact: true,
        })
        const toolbar = installed.locator('.toolbar')
        const tabsBounds = (await scope
          .locator('.el-tabs__header')
          .boundingBox())!
        const toolbarBounds = (await toolbar.boundingBox())!
        const tableBounds = (await installed
          .locator('.el-table')
          .boundingBox())!
        expect(
          toolbarBounds.y - tabsBounds.y - tabsBounds.height,
        ).toBeGreaterThanOrEqual(16)
        expect(
          tableBounds.y - toolbarBounds.y - toolbarBounds.height,
        ).toBeGreaterThanOrEqual(16)
        const installBounds = (await toolbar
          .getByRole('button', { name: '安装扩展包', exact: true })
          .boundingBox())!
        const connectBounds = (await toolbar
          .getByRole('button', { name: '连接 MCP', exact: true })
          .boundingBox())!
        expect(
          connectBounds.x - installBounds.x - installBounds.width,
        ).toBeGreaterThanOrEqual(6)
        expect(
          connectBounds.x - installBounds.x - installBounds.width,
        ).toBeLessThanOrEqual(12)
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true)
        if (width === 1440 || width === 390)
          await page.screenshot({
            path: info.outputPath(
              `extensions-${surface}-${theme}-${width}.png`,
            ),
            animations: 'disabled',
          })
        await toolbar
          .getByRole('button', { name: '连接 MCP', exact: true })
          .click()
        const form = scope.getByRole('tabpanel', {
          name: 'MCP 连接',
          exact: true,
        })
        await expect(form.getByLabel('HTTP 端点')).toBeVisible()
        await checkFormSpacing(form)
        await scope
          .getByRole('tab', { name: '已安装来源', exact: true })
          .click()
      }
      if (surface === 'dialog')
        await scope
          .getByRole('button', { name: '关闭此对话框', exact: true })
          .click()
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
