import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { captureDesign } from './design-capture'

test('草稿刷新后可恢复，模型费率从试算到发布', async ({ page }) => {
  test.skip(process.env.WEB_ADMIN_E2E_LIVE !== '1', '使用隔离后端')
  test.setTimeout(120000)
  const sku = 'draft-' + randomUUID().slice(0, 8)
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
  await page.getByRole('button', { name: '新增套餐' }).click()
  let dialog = page.getByRole('dialog')
  await dialog.getByLabel('商品编码').fill(sku)
  await dialog.getByLabel('套餐名称').fill('恢复草稿')
  await dialog.getByLabel('价格（元）').fill('29')
  await dialog.getByLabel('每周额度').fill('120')
  await dialog.getByLabel('每月额度').fill('300')
  await dialog.getByLabel('发布原因').fill('测试草稿')
  await dialog.getByRole('button', { name: '保存草稿' }).click()
  await expect(dialog).toHaveCount(0)
  await page.reload()
  await page.getByRole('button', { name: '商品草稿' }).click()
  await dialog
    .locator('article')
    .filter({ hasText: sku })
    .getByRole('button', { name: '继续编辑' })
    .click()
  await expect(dialog.getByLabel('每周额度')).toHaveValue('120')
  await expect(dialog.getByLabel('每月额度')).toHaveValue('300')
  await dialog.getByLabel('每月额度').fill('350')
  await dialog.getByRole('button', { name: '核对发布' }).click()
  await dialog.getByRole('button', { name: '确认发布' }).click()
  await expect(page.getByRole('row').filter({ hasText: sku })).toContainText(
    '350',
  )
  await page.goto('/#/billing/rates')
  await page.getByRole('button', { name: '新增费率' }).click()
  dialog = page.getByRole('dialog', { name: '费率与试算' })
  await dialog.getByLabel('模型配置编号').fill(sku)
  await expect(dialog.getByText('100 点', { exact: true })).toBeVisible()
  await dialog.getByLabel('试算数量').fill('8')
  await expect(dialog.getByText('160 点', { exact: true })).toBeVisible()
  await captureDesign(page, 'pricing-720p-8s.png')
  await dialog.getByLabel('每组点数').fill('25')
  await expect(dialog.getByText('200 点', { exact: true })).toBeVisible()
  await dialog.getByLabel('变更原因').fill('合成费率')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(
    dialog.getByRole('button', { name: '保存费率草稿' }),
  ).toBeInViewport()
  await captureDesign(page, 'pricing-trial-mobile.png')
  await dialog.getByRole('button', { name: '保存费率草稿' }).click()
  let row = page.getByRole('row').filter({ hasText: sku })
  await expect(row).toBeVisible()
  await page.reload()
  await page.getByLabel('版本状态').selectOption('draft')
  await row.getByRole('button', { name: '查看与试算' }).click()
  await expect(dialog.getByLabel('每组点数')).toHaveValue('25')
  await page.setViewportSize({ width: 1280, height: 560 })
  await expect(
    dialog.getByRole('button', { name: '确认发布费率' }),
  ).toBeInViewport()
  await captureDesign(page, 'pricing-review-short.png')
  await dialog.getByRole('button', { name: '确认发布费率' }).click()
  await expect(page.getByLabel('版本状态')).toHaveValue('effective')
  await page.getByLabel('搜索费率条件').fill(sku)
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  row = page.getByRole('row').filter({ hasText: sku })
  await expect(row).toContainText('25')
  for (const [width, colorScheme] of [
    [390, 'light'],
    [768, 'dark'],
    [1280, 'light'],
    [1440, 'dark'],
  ] as const) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.emulateMedia({ colorScheme })
    await expect(row).toBeVisible()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
    await captureDesign(page, 'pricing-rates-' + width + '.png')
  }
})
