import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { loginIsolatedAccount } from './live-auth'
import { captureDesign } from './design-capture'

/** 独立平台真实办理，覆盖会员、延期与用户管理行内入账，再用本人身份核对。 */
test('运营开通、续期和加额在本人账本生效', async ({ page, request }) => {
  test.skip(process.env.WEB_ADMIN_E2E_LIVE !== '1', '仅运行于隔离后端')
  test.setTimeout(120000)
  const admin = process.env.WEB_ADMIN_E2E_USERNAME ?? 'foundation-admin',
    password = process.env.WEB_ADMIN_E2E_PASSWORD!
  const adminLogin = await loginIsolatedAccount(request, admin, password)
  const headers = {
    authorization: 'Bearer ' + (await adminLogin.json()).accessToken,
  }
  const username = 'billing-' + randomUUID().slice(0, 10),
    pass = randomUUID() + '!'
  const created = await request.post('/api/admin/users', {
    headers,
    data: {
      username,
      displayName: '会员联调账号',
      password: pass,
      roles: ['member'],
    },
  })
  expect(created.status(), await created.text()).toBe(201)
  const userId = (await created.json()).userId
  await page.goto('/#/login')
  await page.getByLabel('用户名或邮箱').fill(admin)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/auth/login') && r.ok()),
    page.getByRole('button', { name: '登录 ↵', exact: true }).click(),
  ])
  await page.waitForURL((url) => !url.hash.startsWith('#/login'))
  await page.goto('/#/billing/subscriptions?userId=' + userId)
  const row = page.getByRole('row').filter({ hasText: username })
  await row.getByRole('button', { name: '开通', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: '会员办理' })
  await dialog.getByLabel('办理商品').selectOption('light-1')
  await dialog.getByLabel('办理原因').fill('内测开通')
  await dialog.getByRole('button', { name: '预览办理' }).click()
  await expect(dialog.getByText('0 → 300')).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await captureDesign(page, 'manual-preview-390.png')
  await dialog.getByRole('button', { name: '确认办理' }).click()
  await expect(row.getByText('300', { exact: true })).toBeVisible()
  await row.getByRole('button', { name: '续期', exact: true }).click()
  await dialog.getByLabel('办理原因').fill('提前续期')
  await dialog.getByRole('button', { name: '预览办理' }).click()
  await expect(dialog.getByText('300 → 300')).toBeVisible()
  await dialog.getByRole('button', { name: '确认办理' }).click()
  await expect(dialog).toBeHidden()
  for (const [width, theme] of [
    [390, 'light'],
    [768, 'dark'],
    [1280, 'light'],
    [1440, 'dark'],
  ] as const) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.emulateMedia({ colorScheme: theme })
    await captureDesign(page, 'manual-directory-' + width + '.png')
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
  }
  await page.goto('/#/access/users')
  await page.getByRole('textbox', { name: '搜索用户' }).fill(username)
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await row.getByRole('button', { name: '加额度' }).click()
  dialog = page.getByRole('dialog', { name: '人工加额' })
  await dialog.getByRole('spinbutton').first().fill('100')
  await dialog.getByLabel('办理原因').fill('样例补额')
  await dialog.getByRole('button', { name: '预览办理' }).click()
  await expect(dialog.getByText('300 → 400')).toBeVisible()
  await dialog.getByRole('button', { name: '确认办理' }).click()
  await expect(row.getByText('可用 400')).toBeVisible()
  await page.goto(
    '/#/billing/subscriptions?userId=' + userId + '&product=entertainment',
  )
  await row.getByRole('button', { name: '办理记录' }).click()
  dialog = page.getByRole('dialog', { name: '历史办理' })
  await expect(dialog.getByText('样例补额', { exact: true })).toBeVisible()
  await expect(dialog.getByText('下次发放', { exact: true })).toBeVisible()
  await page.setViewportSize({ width: 1280, height: 560 })
  await dialog.getByRole('button', { name: '关闭', exact: true }).last().click()
  await row.getByRole('button', { name: '加额度' }).click()
  dialog = page.getByRole('dialog', { name: '人工加额' })
  await dialog.getByLabel('办理类型').selectOption('topup')
  await dialog.getByLabel('收款凭证号').fill('TEST-' + randomUUID())
  await dialog.getByLabel('办理原因').fill('核对合成收款凭证')
  await dialog.getByLabel('实收金额（元）').fill('18')
  await expect(dialog.getByRole('button', { name: '预览办理' })).toBeDisabled()
  await dialog.getByLabel('实收金额（元）').fill('19')
  await dialog.getByRole('button', { name: '预览办理' }).click()
  await expect(dialog.getByText('400 → 580')).toBeVisible()
  await dialog.getByRole('button', { name: '确认办理' }).click()
  await expect(row.getByText('580', { exact: true })).toBeVisible()
  const first = await loginIsolatedAccount(request, username, pass)
  const changed = await request.post('/api/auth/change-password', {
    headers: { authorization: 'Bearer ' + (await first.json()).accessToken },
    data: { newPassword: pass },
  })
  expect(changed.status()).toBe(204)
  const customer = await loginIsolatedAccount(request, username, pass)
  const own = { authorization: 'Bearer ' + (await customer.json()).accessToken }
  expect(
    (await (await request.get('/api/me/billing', { headers: own })).json())
      .availablePoints,
  ).toBe(580)
  expect(
    (
      await request.get('/api/admin/billing/subscriptions', { headers: own })
    ).status(),
  ).toBe(403)
})
