import { expect, test } from '@playwright/test'
import { installParityFixture } from '../parity/ui-fixture'
import { expectControlAppearance } from './control-appearance'
import { captureDesign } from './design-capture'

/** 上传入口只打开和取消，不选择文件、不写入任何真实资料。 */
for (const product of ['office', 'entertainment']) {
  for (const theme of ['light', 'dark']) {
    test(`原生上传 ${product} ${theme}：导入与上传入口`, async ({ page }) => {
      test.setTimeout(90000)
      await page.addInitScript(
        (value) => localStorage.setItem('starbridge.theme', value),
        theme,
      )
      const state = await installParityFixture(page, { bothProducts: true })
      const editors: (readonly [string, string])[] = [
        ...(product === 'office'
          ? [['/account/files', '上传文件'] as const]
          : []),
        ['/skills', '导入技能包'],
        ['/account/profile', '更换头像'],
      ]
      for (const [path, trigger] of editors) {
        await page.goto(`/#${path}?product=${product}`, { timeout: 90000 })
        await page.getByRole('button', { name: trigger, exact: true }).click()
        const dialog = page.getByRole('dialog', { name: trigger, exact: true })
        await expect(dialog.locator('input[type="file"]')).toBeVisible()
        for (const width of [1440, 1280, 768, 390]) {
          await page.setViewportSize({
            width,
            height: width === 390 ? 844 : 1000,
          })
          await expectControlAppearance(dialog)
          expect(
            await dialog
              .locator('.el-dialog__body')
              .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
          ).toBe(true)
          if (width === 1440 || width === 390)
            await captureDesign(
              page,
              `native-${path.replaceAll('/', '-')}-${product}-${theme}-${width}.png`,
            )
        }
        await dialog
          .getByRole('button', { name: '关闭此对话框', exact: true })
          .click()
        await expect(dialog).toBeHidden()
      }
      expect(state.missing).toEqual([])
      expect(
        state.requests.filter((r) => /^(PUT|PATCH|DELETE) /u.test(r)),
      ).toEqual([])
    })
  }
}
