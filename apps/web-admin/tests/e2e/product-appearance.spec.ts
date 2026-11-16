import { expect, test } from '@playwright/test'
import { installFoundationFixture } from './foundation-fixture'

test('通过产品入口离开脏表单时可以继续编辑、保存或放弃', async ({ page }) => {
  const state = await installFoundationFixture(page, [
    'products.office',
    'products.entertainment',
    'users.read',
    'users.manage',
  ])
  state.signedIn = true
  await page.goto('/#/access/users')
  const create = page.getByRole('button', { name: '创建用户', exact: true })
  const editor = page.getByRole('dialog', { name: '创建用户' })
  const prompt = page.getByRole('dialog', { name: '未保存的修改' })
  await create.click()
  await editor.getByLabel('用户名', { exact: true }).fill('design-test')
  await editor.getByLabel('显示名称').fill('保存前的草稿')
  await editor.getByLabel('初始密码').fill('Synthetic-pass-123!')
  // 调用同一处产品链接触发 Vue 导航。弹层的遮罩会拦住物理鼠标。
  const switchProduct = () =>
    page
      .locator('.console-product-switch')
      .evaluate((link: HTMLAnchorElement) => link.click())
  await switchProduct()
  await expect(prompt).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(prompt).toBeHidden()
  await expect(editor).toBeVisible()
  await expect(editor.getByLabel('显示名称')).toHaveValue('保存前的草稿')
  await switchProduct()
  await prompt.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page).toHaveURL(/#\/products$/)
  expect(state.requests.filter((r) => r === 'POST /admin/users')).toHaveLength(
    1,
  )
  await page.goto('/#/access/users')
  await create.click()
  await editor.getByLabel('用户名', { exact: true }).fill('discard-me')
  await switchProduct()
  await prompt.getByRole('button', { name: '放弃修改' }).click()
  await expect(page).toHaveURL(/#\/products$/)
  expect(state.requests.filter((r) => r === 'POST /admin/users')).toHaveLength(
    1,
  )
})

/** 使用同一登录往返两个产品。落在 body 的下拉层也必须随品牌和用户明暗变化。 */
test('共享外观支持键盘切换、独立产品色和系统偏好', async ({ page }) => {
  const state = await installFoundationFixture(page, [
    'products.office',
    'products.entertainment',
    'users.read',
    'studio.projects.read',
    'studio.assets.read',
  ])
  state.signedIn = true
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/#/access/users')
  const root = page.locator('html')
  const theme = page.getByRole('button', { name: '选择外观' })
  await expect(root).toHaveAttribute('data-console-product', 'office')
  await expect(page.locator('.console-sidebar')).toHaveCSS(
    'background-color',
    'rgb(255, 255, 255)',
  )
  await theme.focus()
  await page.keyboard.press('Enter')
  const dark = page.getByText('深色', { exact: true })
  await expect(dark).toBeVisible()
  await expect(
    dark.locator('xpath=ancestor::*[contains(@class,"el-popper")][1]'),
  ).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await dark.click()
  await expect(page.locator('.console-sidebar')).toHaveCSS(
    'background-color',
    'rgb(37, 46, 56)',
  )
  await page.getByRole('link', { name: '切换产品' }).click()
  await expect(root).not.toHaveAttribute('data-console-product')
  await page.getByRole('link', { name: /星桥娱乐/ }).click()
  await expect(root).toHaveAttribute('data-console-product', 'entertainment')
  await expect(page.locator('.console-sidebar')).toHaveCSS(
    'background-color',
    'rgb(36, 35, 33)',
  )
  await page.reload()
  await expect(root).toHaveClass(/dark/)
  await theme.click()
  await page.getByText('跟随系统', { exact: true }).click()
  await expect(page.locator('.console-sidebar')).toHaveCSS(
    'background-color',
    'rgb(255, 252, 247)',
  )
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('.console-sidebar')).toHaveCSS(
    'background-color',
    'rgb(36, 35, 33)',
  )
  for (const width of [390, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(page.getByRole('link', { name: '切换产品' })).toBeVisible()
    if (width <= 768) {
      await page.getByRole('button', { name: '打开导航' }).click()
      const drawer = page.getByRole('dialog', { name: '平台导航' })
      await expect(drawer).toBeVisible()
      await expect(
        drawer.getByRole('link', { name: '作品项目', exact: true }),
      ).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(drawer).toBeHidden()
    } else await expect(page.locator('.console-sidebar')).toBeVisible()
    // 抽屉关闭动画和视口重排均完成后，页面不应保留横向滚动区域。
    await expect
      .poll(
        () =>
          page.evaluate(
            () => document.documentElement.scrollWidth - innerWidth,
          ),
        { message: `产品切换后 ${width}px 视口出现横向溢出` },
      )
      .toBeLessThanOrEqual(0)
  }
  await page.goto('/#/website?product=office')
  await expect(root).not.toHaveAttribute('data-console-product')
})
