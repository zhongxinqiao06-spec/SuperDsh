import { randomUUID } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
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
        product: theme === 'dark' ? 'entertainment' : 'office',
      })
      if (calls === 1)
        return route.fulfill({
          status: 409,
          json: { detail: '请先设置另一名可用管理员，再注销此账号。' },
        })
      state.signedIn = false
      return route.fulfill({
        status: 202,
        json: {
          status: 'closed',
          product: route.request().postDataJSON().product,
        },
      })
    })
    await page.goto(
      '/#/account/profile?product=' +
        (theme === 'dark' ? 'entertainment' : 'office'),
      { waitUntil: 'domcontentloaded' },
    )
    const open = page.getByRole('button', { name: '注销账号', exact: true })
    const modal = page.getByRole('dialog', { name: '确认注销账号？' })
    for (const width of [390, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 940 })
      await open.click()
      await expect(modal).toBeVisible()
      await expect(modal.getByText('admin', { exact: true })).toBeVisible()
      await expect(modal.getByText(/领取体验额度/)).toBeVisible()
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
  // 已打开的旧标签页发送上一版协议，后端必须先拒绝，再允许刷新后的页面注销。
  await page.route('**/api/auth/me', async (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback()
    const { accountId, confirm } = route.request().postDataJSON()
    await route.continue({ postData: JSON.stringify({ accountId, confirm }) })
  })
  await dialog
    .getByRole('button', { name: '确认注销账号', exact: true })
    .click()
  await expect(dialog.getByText(/页面已更新，账号仍然保留/)).toBeVisible()
  expect(
    (
      await request.get('/api/auth/me', {
        headers: { authorization: 'Bearer ' + token },
      })
    ).status(),
  ).toBe(200)
  await page.unroute('**/api/auth/me')
  await page.reload()
  await open.click()
  const result = page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/auth/me') && r.request().method() === 'DELETE',
  )
  await dialog
    .getByRole('button', { name: '确认注销账号', exact: true })
    .click()
  const closed = await result
  expect(closed.status()).toBe(202)
  expect(await closed.json()).toEqual({ status: 'closed', product: 'office' })
  await expect(page).toHaveURL(/#\/login/)
  expect(
    (
      await request.get('/api/auth/me', {
        headers: { authorization: 'Bearer ' + token },
      })
    ).status(),
  ).toBe(401)
})

// 从两个产品的正式注册入口各走两遍。只有邮件投递使用隔离收件箱。
for (const product of ['entertainment', 'office'] as const) {
  test(`独立后端 ${product} 注销后同邮箱注册保留产品与默认角色`, async ({
    page,
    request,
  }) => {
    test.skip(process.env.WEB_ADMIN_E2E_LIVE !== '1', '仅运行于隔离后端')
    test.setTimeout(90_000)
    const admin = await loginIsolatedAccount(
      request,
      process.env.WEB_ADMIN_E2E_USERNAME ?? 'foundation-admin',
      process.env.WEB_ADMIN_E2E_PASSWORD!,
    )
    const headers = {
      authorization: 'Bearer ' + (await admin.json()).accessToken,
    }
    const original = (await (await request.get('/api/auth/config')).json())
      .registrationOpen
    const email = 'registration-' + randomUUID() + '@example.invalid'
    const inbox = join(
      process.env.WEB_ADMIN_VALIDATION_DIR!,
      'registration-mail',
      email,
    )
    const role =
      product === 'entertainment' ? 'entertainment_creator' : 'member'
    const notice =
      product === 'entertainment'
        ? '星桥娱乐 · 创作者账号'
        : '星桥办公 · 办公账号'
    const password = randomUUID() + '!'
    async function register() {
      await expect(page.locator('.login-intro--registration')).toContainText(
        notice,
      )
      await page.getByLabel('邮箱', { exact: true }).fill(email)
      await page
        .getByRole('button', { name: '发送验证码', exact: true })
        .click()
      const code = page.getByLabel('验证码', { exact: true })
      await expect(code).toBeVisible()
      await code.fill(await readFile(inbox, 'ascii'))
      await unlink(inbox)
      await page.getByLabel('设置密码', { exact: true }).fill(password)
      const registered = page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          r.url().endsWith('/api/auth/register'),
      )
      await page.getByRole('button', { name: '验证并创建账号' }).click()
      const response = await registered
      expect(response.ok()).toBe(true)
      expect(response.request().postDataJSON().product).toBe(product)
      const account = await response.json()
      expect(account.roles).toEqual([role])
      expect(account.registrationGrant.points).toBe(200)
      await expect(page).toHaveURL(new RegExp('#/' + product + '$'))
      const wallet = await request.get('/api/me/billing', {
        headers: { authorization: 'Bearer ' + account.accessToken },
      })
      expect((await wallet.json()).availablePoints).toBe(200)
      return account.userId as string
    }
    try {
      expect(
        (
          await request.patch('/api/admin/settings', {
            headers,
            data: { registrationOpen: true },
          })
        ).ok(),
      ).toBe(true)
      await page.goto('/#/register?product=' + product)
      const first = await register()
      await page.goto('/#/account/profile')
      await page.getByRole('button', { name: '注销账号', exact: true }).click()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: '确认注销账号', exact: true })
        .click()
      await expect(page).toHaveURL(
        new RegExp('#/login\\?product=' + product + '$'),
      )
      await page.getByRole('link', { name: '创建账号', exact: true }).click()
      await expect(page).toHaveURL(
        new RegExp('#/register\\?product=' + product + '$'),
      )
      expect(await register()).not.toBe(first)
    } finally {
      expect(
        (
          await request.patch('/api/admin/settings', {
            headers,
            data: { registrationOpen: original },
          })
        ).ok(),
      ).toBe(true)
    }
  })
}

test('旧登录链接从个人资料的返回地址恢复注册产品', async ({ page }) => {
  await installFoundationFixture(page)
  await page.route('**/api/auth/config', (r) =>
    r.fulfill({
      json: { registrationOpen: true, registrationEmailAvailable: true },
    }),
  )
  await page.goto(
    '/#/login?returnTo=' +
      encodeURIComponent('/account/profile?product=entertainment'),
  )
  await page.getByRole('link', { name: '创建账号', exact: true }).click()
  await expect(page.locator('.login-intro--registration')).toContainText(
    '星桥娱乐 · 创作者账号',
  )
})
