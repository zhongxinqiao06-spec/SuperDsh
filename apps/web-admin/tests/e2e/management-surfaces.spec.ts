import { expect, test } from '@playwright/test'
import { installParityFixture } from '../parity/ui-fixture'
import { expectControlAppearance } from './control-appearance'
import { captureDesign } from './design-capture'

/** 从正常路由检查共享详情和长编辑表单；缩窄视口与展开下拉都应保留草稿。 */
for (const product of ['office', 'entertainment']) {
  for (const theme of ['light', 'dark']) {
    test(`管理详情与长表单 ${product} ${theme}`, async ({ page }) => {
      test.setTimeout(90000)
      await page.emulateMedia({
        colorScheme: theme === 'dark' ? 'dark' : 'light',
      })
      await installParityFixture(page, { bothProducts: true })
      await page.goto('/#/account/profile?product=' + product, {
        waitUntil: 'domcontentloaded',
      })
      await expect(
        page.getByRole('heading', { name: '个人资料' }),
      ).toBeVisible()
      await expect(
        page.getByText('合成管理员', { exact: true }).last(),
      ).toBeVisible()
      await captureDesign(page, `profile-${product}-${theme}.png`)
      await page.goto('/#/models?product=' + product)
      await page.getByRole('button', { name: '新增连接' }).click()
      const dialog = page.getByRole('dialog', { name: '供应商连接' })
      const name = dialog.getByLabel('连接名称')
      await name.fill('影像工作室')
      await dialog.getByLabel('API 地址').fill('https://studio.example.com/api')
      await dialog.getByRole('combobox').press('Enter')
      await page.getByRole('option', { name: 'Anthropic Messages' }).click()
      for (const width of [1440, 1280, 768, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 940 })
        await expectControlAppearance(dialog)
        await expect(name).toHaveValue('影像工作室')
        const body = dialog.locator('.el-dialog__body')
        expect(
          await body.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        ).toBe(true)
        await body.evaluate((el) => {
          el.scrollTop = el.scrollHeight
        })
        await expect(
          dialog.getByRole('button', { name: '保存' }),
        ).toBeInViewport()
        await body.evaluate((el) => {
          el.scrollTop = 0
        })
        if (width === 1440 || width === 390) {
          await captureDesign(
            page,
            `connection-${product}-${theme}-${width}.png`,
          )
        }
      }
      await page.setViewportSize({ width: 1280, height: 560 })
      const credential = dialog.getByLabel('API Key', { exact: true })
      await credential.scrollIntoViewIfNeeded()
      const fieldBox = await credential.boundingBox()
      const footerBox = await dialog.locator('.el-dialog__footer').boundingBox()
      expect(fieldBox!.y + fieldBox!.height).toBeLessThanOrEqual(
        footerBox!.y + 1,
      )
      await dialog.getByRole('button', { name: '取消' }).click()
      await expect(dialog).toBeHidden()
      await page.route('**/api/admin/audit?*', (route) =>
        route.fulfill({
          json: {
            events: [
              {
                id: 'example',
                action: 'model.connection.update',
                actorUsername: '合成管理员',
                targetId: 'studio-example',
                createdAt: '2026-11-24T02:30:00Z',
                detail: {
                  连接名称: '影像工作室',
                  模型标识: 'studio-example-'.repeat(6),
                },
              },
            ],
            total: 1,
            page: 1,
            pageSize: 10,
          },
        }),
      )
      await page.goto('/#/system/audit?product=' + product)
      await page.setViewportSize({ width: 1280, height: 900 })
      await page.getByRole('button', { name: '查看', exact: true }).click()
      const detail = page.getByRole('dialog', { name: '审计详情' })
      await expect(detail.getByText('model.connection.update')).toBeVisible()
      await captureDesign(page, `audit-${product}-${theme}.png`)
      await page.setViewportSize({ width: 390, height: 844 })
      const facts = detail.locator('.details')
      expect(
        await facts.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      ).toBe(true)
      await detail.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(detail).toBeHidden()
    })
  }
}
