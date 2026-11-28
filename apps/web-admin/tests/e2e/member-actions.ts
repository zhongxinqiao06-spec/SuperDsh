import type { Page, Locator } from '@playwright/test'

/** 桌面使用锚定菜单，手机使用以收件人命名的操作面板。 */
export async function memberAction(
  page: Page,
  row: Locator,
  group: string,
  action: string,
) {
  await row.getByRole('button', { name: group, exact: true }).click()
  await page
    .getByRole('menuitem', { name: action, exact: true })
    .or(
      page
        .getByRole('dialog')
        .getByRole('button', { name: action, exact: true }),
    )
    .click()
}
