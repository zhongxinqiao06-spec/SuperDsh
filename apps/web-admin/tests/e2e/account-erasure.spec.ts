import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { loginIsolatedAccount } from './live-auth'
import { installFoundationFixture } from './foundation-fixture'
import { captureDesign } from './design-capture'

for (const theme of ['light', 'dark'] as const) {
  test(`个人注销确认、取消与重试 ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    const state = await installFoundationFixture(page, [
      'products.office',
      'products.entertainment',
    ])
    state.signedIn = true
    let calls = 0
    await page.route('**/auth/me', async (route) => {
      if (route.request().method() !== 'DELETE') return route.fallback()
      calls++
      expect(route.request().postDataJSON()).toEqual({
        accountId: 'fixture-admin',
        confirm: true,
      })
      if (calls === 1)
        return route.fulfill({
          status: 409,
          json: { detail: '请先设置另一名可用管理员，再注销此账号。' },
        })
      state.signedIn = false
      return route.fulfill({ status: 202, json: { status: 'closed' } })
    })
    await page.goto(
      '/#/account/profile?product=' +
        (theme === 'dark' ? 'entertainment' : 'office'),
    )
    const open = page.getByRole('button', { name: '注销账号', exact: true })
    const modal = page.getByRole('dialog', { name: '确认注销账号？' })
    for (const width of [390, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 940 })
      await open.click()
      await expect(modal).toBeVisible()
      await expect(modal.getByText('admin', { exact: true })).toBeVisible()
      await expect(modal.getByText(/40 点体验额度/)).toBeVisible()
      const bounds = await modal.boundingBox()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1)
      await captureDesign(page, `erasure-${theme}-${width}.png`)
      if (width === 768) await page.keyboard.press('Escape')
      else
        await modal.getByRole('button', { name: '取消', exact: true }).click()
      await expect(modal).toBeHidden()
    }
    expect(calls).toBe(0)
    await open.click()
    await modal
      .getByRole('button', { name: '确认注销账号', exact: true })
      .click()
    await expect(
      modal.getByText('请先设置另一名可用管理员，再注销此账号。'),
    ).toBeVisible()
    await modal
      .getByRole('button', { name: '确认注销账号', exact: true })
      .click()
    await expect(page).toHaveURL(/#\/login/)
    expect(calls).toBe(2)
  })
}

test('独立后端本人从资料页注销并撤销既有会话', async ({ page, request }) => {
  test.skip(process.env.WEB_ADMIN_E2E_LIVE !== '1', '仅运行于隔离后端')
  const admin = await loginIsolatedAccount(
    request,
    process.env.WEB_ADMIN_E2E_USERNAME ?? 'foundation-admin',
    process.env.WEB_ADMIN_E2E_PASSWORD!,
  )
  const username = 'erase-' + randomUUID().slice(0, 12)
  const password = randomUUID() + '!'
  const created = await request.post('/api/admin/users', {
    headers: { authorization: 'Bearer ' + (await admin.json()).accessToken },
    data: { username, password, displayName: username, roles: ['member'] },
  })
  expect(created.status(), await created.text()).toBe(201)
  const login = await loginIsolatedAccount(
    page.request,
    username,
    password,
    'browser',
  )
  expect(login.status(), await login.text()).toBe(200)
  const token = (await login.json()).accessToken
  await page.goto('/#/account/profile')
  const open = page.getByRole('button', { name: '注销账号', exact: true })
  const dialog = page.getByRole('dialog', { name: '确认注销账号？' })
  await open.click()
  await expect(dialog.getByText(username, { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  expect(
    (
      await request.get('/api/auth/me', {
        headers: { authorization: 'Bearer ' + token },
      })
    ).status(),
  ).toBe(200)
  await open.click()
  const result = page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/auth/me') && r.request().method() === 'DELETE',
  )
  await dialog
    .getByRole('button', { name: '确认注销账号', exact: true })
    .click()
  expect((await result).status()).toBe(202)
  await expect(page).toHaveURL(/#\/login/)
  expect(
    (
      await request.get('/api/auth/me', {
        headers: { authorization: 'Bearer ' + token },
      })
    ).status(),
  ).toBe(401)
})
