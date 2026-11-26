import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { captureDesign } from './design-capture'

/** 运营浏览器发布独立商品，核对会员可见目录和撤回记录。 */
test('套餐版本发布、定时撤回和下架贯穿运营与个人目录', async ({ page }) => {
  test.skip(process.env.WEB_ADMIN_E2E_LIVE !== '1', '仅运行于隔离后端')
  test.setTimeout(120000)
  const sku = 'annual-' + randomUUID().slice(0, 8),
    name = '年度体验 ' + sku
  await page.goto('/#/login')
  await page
    .getByLabel('用户名或邮箱')
    .fill(process.env.WEB_ADMIN_E2E_USERNAME ?? 'foundation-admin')
  await page
    .getByLabel('密码', { exact: true })
    .fill(process.env.WEB_ADMIN_E2E_PASSWORD!)
  await page.getByRole('button', { name: '登录 ↵', exact: true }).click()
  await page.waitForURL((u) => !u.hash.startsWith('#/login'))
  await page.goto('/#/billing/plans')
  const title = page.getByRole('heading', { name: '套餐版本管理', exact: true })
  await expect(title).toBeVisible()
  await expect(page.getByRole('navigation', { name: '相关设置' })).toHaveCount(
    0,
  )
  await page.getByRole('button', { name: '新增套餐' }).click()
  let dialog = page.getByRole('dialog', { name: '新增套餐' })
  await dialog.getByLabel('商品编码').fill(sku)
  await dialog.getByLabel('套餐名称').fill(name)
  await dialog.getByLabel('权益期限').selectOption('year')
  await dialog.getByLabel('价格（元）').fill('99.90')
  await dialog.getByLabel('发放创作点').fill('1200')
  await dialog.getByLabel('发布原因').fill('合成首发')
  await dialog.getByRole('button', { name: '核对发布' }).click()
  await expect(dialog.getByText(/99.9.*1,200/)).toBeVisible()
  await dialog.getByRole('button', { name: '确认发布' }).click()
  const row = page.getByRole('row').filter({ hasText: sku })
  await expect(row.getByText('v1 · 在售')).toBeVisible()
  await page.goto('/#/account/plans')
  await expect(
    page.getByRole('button', { name: new RegExp(name) }),
  ).toContainText('年')
  await page.goto('/#/billing/plans?product=entertainment')
  await row.getByRole('button', { name: '发布新版本' }).click()
  dialog = page.getByRole('dialog', { name: '发布套餐版本' })
  await dialog.getByLabel('发布原因').fill('同条款检查')
  await expect(dialog.getByRole('button', { name: '核对发布' })).toBeDisabled()
  await dialog.getByLabel('价格（元）').fill('129')
  await dialog.getByLabel('发放创作点').fill('1800')
  await dialog.getByLabel('生效方式').selectOption('scheduled')
  const date = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 16)
  await dialog.getByLabel('生效时间（北京时间）').fill(date)
  await dialog.getByLabel('发布原因').fill('后续调价')
  await dialog.getByRole('button', { name: '核对发布' }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(
    dialog.getByRole('button', { name: '确认发布' }),
  ).toBeInViewport()
  await captureDesign(page, 'catalog-preview-390.png')
  await dialog.getByRole('button', { name: '确认发布' }).click()
  await expect(row.getByText('v2 · 上架')).toBeVisible()
  for (const [width, colorScheme] of [
    [390, 'light'],
    [768, 'dark'],
    [1280, 'light'],
    [1440, 'dark'],
  ] as const) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.emulateMedia({ colorScheme })
    await row
      .getByRole('button', { name: '撤回定时发布' })
      .scrollIntoViewIfNeeded()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
    await captureDesign(page, 'catalog-list-' + width + '.png')
  }
  await row.getByRole('button', { name: '撤回定时发布' }).click()
  dialog = page.getByRole('dialog', { name: '撤回待生效版本' })
  await dialog.getByLabel('撤回原因').fill('合成排期调整')
  await dialog.getByRole('button', { name: '确认撤回' }).click()
  await expect(row.getByRole('button', { name: '发布新版本' })).toBeVisible()
  await row.getByRole('button', { name: '发布新版本' }).click()
  dialog = page.getByRole('dialog', { name: '发布套餐版本' })
  await dialog.getByLabel('销售状态').selectOption({ label: '下架' })
  await dialog.getByLabel('发布原因').fill('合成下架')
  await dialog.getByRole('button', { name: '核对发布' }).click()
  await dialog.getByRole('button', { name: '确认发布' }).click()
  await expect(row.getByText('v3 · 已下架')).toBeVisible()
  await row.getByRole('button', { name: '版本历史' }).click()
  dialog = page.getByRole('dialog', { name: '套餐版本历史' })
  await page.setViewportSize({ width: 1280, height: 560 })
  await expect(dialog.getByText('合成排期调整', { exact: true })).toBeVisible()
  await dialog.getByText('合成首发', { exact: true }).scrollIntoViewIfNeeded()
  await expect(
    dialog.getByRole('button', { name: '关闭', exact: true }).last(),
  ).toBeInViewport()
  await captureDesign(page, 'catalog-history-short.png')
  await dialog.getByRole('button', { name: '关闭', exact: true }).last().click()
  await page.goto('/#/account/plans')
  await expect(page.getByRole('button', { name: /轻享会员/ })).toBeVisible()
  await expect(
    page.getByRole('button', { name: new RegExp(name) }),
  ).toHaveCount(0)
})
