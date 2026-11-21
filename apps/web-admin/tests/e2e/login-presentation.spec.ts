import { expect, test } from '@playwright/test'
import { installFoundationFixture } from './foundation-fixture'

test('隔离认证服务接受表单提交并恢复受保护的深链', async ({ page }) => {
  test.setTimeout(120_000)
  const password = process.env.WEB_ADMIN_E2E_PASSWORD
  test.skip(
    process.env.WEB_ADMIN_E2E_LIVE !== '1' || !password,
    '需要独立测试库和合成账号',
  )
  await page.goto('/#/account/security', {
    waitUntil: 'domcontentloaded',
    timeout: 90_000,
  })
  await expect(page).toHaveURL(/#\/login\?returnTo=/, { timeout: 60_000 })
  await page
    .getByLabel('用户名或邮箱')
    .fill(process.env.WEB_ADMIN_E2E_USERNAME ?? 'foundation-admin')
  await page.getByLabel('密码', { exact: true }).fill(password!)
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/auth/login') && r.request().method() === 'POST',
  )
  await page.getByLabel('密码', { exact: true }).press('Enter')
  expect((await response).ok()).toBeTruthy()
  await expect(page).toHaveURL(/#\/account\/security$/)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(
    page.getByRole('button', { name: '登录 ↵', exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('heading', { name: /安全/ }).first(),
  ).toBeVisible()
})

test('登录胶片与表单适配窄屏、字距、键盘和减少动态偏好', async ({ page }) => {
  await installFoundationFixture(page)
  await page.goto('/#/login')
  const submit = page.getByRole('button', { name: '登录 ↵', exact: true })
  await expect(submit).toBeVisible()
  const artwork = page.locator('.film-negative img')
  await expect(artwork).toHaveJSProperty('naturalWidth', 989)
  for (const width of [390, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 820 })
    await expect(page.locator('.login-page')).toHaveJSProperty(
      'scrollWidth',
      width,
    )
    const box = await submit.boundingBox()
    const label = await submit.locator('.login-submit-label').boundingBox()
    expect(box).toBeTruthy()
    expect(label).toBeTruthy()
    if (box && label)
      expect(
        Math.abs(box.x + box.width / 2 - label.x - label.width / 2),
      ).toBeLessThan(1)
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator('.film-edge')).toBeHidden()
  await page.getByLabel('密码', { exact: true }).fill('example')
  await page.getByRole('button', { name: '显示密码' }).click()
  await expect(page.getByLabel('密码', { exact: true })).toHaveAttribute(
    'type',
    'text',
  )
  await page.getByRole('button', { name: '隐藏密码' }).click()
  await page.getByLabel('密码', { exact: true }).press('Enter')
  await expect(page.getByText('请输入账号和密码')).toBeVisible()
  await page.getByRole('button', { name: '忘记密码？' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()
  await page.getByRole('button', { name: 'English' }).click()
  await expect(
    page.getByRole('heading', { name: 'Sign in to Starbridge' }),
  ).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Privacy notice' }),
  ).toHaveAttribute('href', /#\/privacy$/)
})

test('开放注册和授权入口随服务器配置展开并保留返回地址', async ({ page }) => {
  await installFoundationFixture(page)
  await page.route('**/api/auth/config', (route) =>
    route.fulfill({
      json: {
        needsBootstrap: false,
        registrationOpen: true,
        emailVerificationRequired: true,
        oauthEnabled: true,
        oauthProviderLabel: 'Studio SSO',
      },
    }),
  )
  await page.setViewportSize({ width: 390, height: 690 })
  await page.goto('/#/login?returnTo=/entertainment')
  await expect(page.getByRole('button', { name: /Studio SSO/ })).toBeVisible()
  await page.getByRole('link', { name: '创建账号' }).click()
  await expect(page.getByLabel('确认密码')).toBeVisible()
  await expect(page.getByRole('button', { name: '发送验证码' })).toBeVisible()
  const back = page.getByRole('link', { name: '已有账号，登录' })
  await back.click()
  await expect(page).toHaveURL(
    /#\/login\?returnTo=\/?entertainment|#\/login\?returnTo=%2Fentertainment/i,
  )
  await expect(page.getByLabel('用户名或邮箱')).toBeVisible()
})
