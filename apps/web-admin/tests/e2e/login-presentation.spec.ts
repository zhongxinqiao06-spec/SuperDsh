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
  await expect(page.getByLabel('设置密码')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '发送验证码' })).toBeVisible()
  const back = page.getByRole('link', { name: '已有账号，登录' })
  await back.click()
  await expect(page).toHaveURL(
    /#\/login\?returnTo=\/?entertainment|#\/login\?returnTo=%2Fentertainment/i,
  )
  await expect(page.getByLabel('用户名或邮箱')).toBeVisible()
})

test('娱乐邮箱注册保留错误草稿并可重新验证', async ({ page }, testInfo) => {
  await installFoundationFixture(page)
  await page.route('**/api/auth/config', (route) =>
    route.fulfill({
      json: {
        needsBootstrap: false,
        registrationOpen: true,
        registrationEmailAvailable: true,
        registrationGrant: { points: 40, validDays: 30 },
        emailVerificationRequired: false,
        oauthEnabled: false,
      },
    }),
  )
  let sends = 0
  let submissions = 0
  await page.route('**/api/auth/email-code', (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      email: 'creator@example.invalid',
      purpose: 'register',
    })
    sends++
    const now = Date.now()
    return route.fulfill({
      json: {
        serverTime: new Date(now).toISOString(),
        expiresAt: new Date(now + 600000).toISOString(),
        resendAt: new Date(now + 60000).toISOString(),
      },
    })
  })
  await page.route('**/api/auth/register', (route) => {
    submissions++
    const body = route.request().postDataJSON()
    expect(body).toMatchObject({
      product: 'entertainment',
      email: 'creator@example.invalid',
      code: '123456',
    })
    expect(body.passwordVerifier).toBeTruthy()
    expect(body.password).toBeUndefined()
    return route.fulfill({
      status: 422,
      json: {
        detail: 'invalid or expired verification code',
        code: 'verification_code_incorrect',
      },
    })
  })
  await page.goto('/#/register?product=entertainment', {
    waitUntil: 'domcontentloaded',
  })
  const send = page.getByRole('button', { name: '发送验证码' })
  await expect(page.getByText(/验证邮箱后获 40 创作点/)).toBeVisible()
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    for (const width of [390, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: 850 })
      await expect(page.locator('.login-page')).toHaveJSProperty(
        'scrollWidth',
        width,
      )
      if (width === 390 || width === 1280)
        await page.screenshot({
          path: testInfo.outputPath(`registration-${colorScheme}-${width}.png`),
          fullPage: true,
        })
    }
  }
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 390, height: 690 })
  await page.getByLabel('邮箱', { exact: true }).fill('creator@example.invalid')
  await send.click()
  await expect(page.getByRole('button', { name: /秒后重发/ })).toBeDisabled()
  const otp = page.getByLabel('验证码', { exact: true })
  const password = page.getByLabel('设置密码', { exact: true })
  await otp.fill('123456')
  await password.fill('Synthetic-test-secret')
  await page.reload()
  await expect(otp).toHaveValue('')
  await expect(password).toHaveValue('')
  await expect(page.getByRole('button', { name: /秒后重发/ })).toBeDisabled()
  await otp.fill('123456')
  await password.fill('Synthetic-test-secret')
  await page.getByRole('button', { name: '验证并创建账号' }).click()
  await expect(page.getByText('验证码不正确，请核对最新邮件。')).toBeVisible()
  await expect(password).toHaveValue('Synthetic-test-secret')
  await expect(otp).toBeFocused()
  expect([sends, submissions]).toEqual([1, 1])
  await page.screenshot({
    path: testInfo.outputPath('registration-verify-mobile.png'),
    fullPage: true,
  })
  await page.getByRole('button', { name: '修改邮箱' }).click()
  await page.getByLabel('邮箱', { exact: true }).fill('another@example.invalid')
  await expect(otp).toHaveCount(0)
  await expect(send).toBeEnabled()
  await page.getByRole('link', { name: '已有账号，登录' }).click()
  await expect(page.getByLabel('用户名或邮箱')).toHaveValue(
    'another@example.invalid',
  )
})

test('注册重发、改邮箱和到账后直接返回办公台', async ({ page }) => {
  await installFoundationFixture(page, ['products.office'])
  await page.route('**/api/auth/config', (r) =>
    r.fulfill({
      json: {
        needsBootstrap: false,
        registrationOpen: true,
        registrationEmailAvailable: true,
        emailVerificationRequired: false,
        oauthEnabled: false,
      },
    }),
  )
  let sends = 0
  await page.route('**/api/auth/email-code', (r) => {
    ++sends
    if (sends === 1)
      return r.fulfill({
        status: 502,
        json: { detail: 'verification email could not be sent' },
      })
    return r.fulfill({
      json: {
        serverTime: '2030-03-01T00:00:00Z',
        expiresAt: '2030-03-01T00:10:00Z',
        resendAt: '2030-03-01T00:00:00Z',
      },
    })
  })
  await page.route('**/api/auth/register', (r) =>
    r.fulfill({
      json: {
        userId: 'example-member',
        email: 'review@example.invalid',
        displayName: 'Example',
        role: 'member',
        roles: ['member'],
        authzVersion: 1,
        permissions: ['products.office'],
        accessToken: 'synthetic-registered',
        tokenType: 'bearer',
        registrationGrant: { points: 40, expiresAt: '2030-03-31T00:00:00Z' },
      },
    }),
  )
  await page.goto('/#/register?product=office')
  await page.getByLabel('邮箱', { exact: true }).fill('review@example.invalid')
  const send = page.getByRole('button', { name: '发送验证码' })
  await send.click()
  await expect(page.getByText(/邮件发送失败/)).toBeVisible()
  await send.click()
  const code = page.getByLabel('验证码', { exact: true }),
    pass = page.getByLabel('设置密码')
  await code.fill('001235')
  await pass.fill('Example-test-123')
  await page.getByRole('button', { name: '重新发送' }).click()
  await expect(code).toHaveValue('')
  await expect(pass).toHaveValue('Example-test-123')
  await code.fill('001236')
  await page.getByRole('button', { name: '验证并创建账号' }).click()
  await expect(page).toHaveURL(/#\/office(?:[/?]|$)/)
  await expect(page.getByText(/体验额度已到账 40 点/)).toBeVisible()
  await expect(
    page.getByRole('link', { name: '查看我的额度明细' }),
  ).toHaveAttribute('href', /#\/account\/membership$/)
  expect(sends).toBe(3)
})

test('服务端限流刷新仍保留倒计时，换邮箱可独立发码或登录', async ({ page }) => {
  await installFoundationFixture(page)
  await page.route('**/api/auth/config', (r) =>
    r.fulfill({
      json: {
        needsBootstrap: false,
        registrationOpen: true,
        registrationEmailAvailable: true,
        oauthEnabled: false,
        emailVerificationRequired: false,
      },
    }),
  )
  await page.route('**/api/auth/email-code', (r) =>
    r.request().postDataJSON().email === 'limited@example.invalid'
      ? r.fulfill({
          status: 429,
          headers: { 'Retry-After': '120' },
          json: {
            detail: 'too many verification emails; try again later',
            code: 'verification_hourly_limit',
          },
        })
      : r.fulfill({
          status: 409,
          json: {
            detail: 'email is already in use',
            code: 'registration_conflict',
          },
        }),
  )
  await page.goto('/#/register', { waitUntil: 'domcontentloaded' })
  const email = page.getByLabel('邮箱', { exact: true })
  await email.fill('limited@example.invalid')
  await page.getByRole('button', { name: '发送验证码' }).click()
  await expect(
    page.getByText('本小时发送次数已达上限，请稍后重试。'),
  ).toBeVisible()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('button', { name: /秒后可重发/ })).toBeDisabled()
  await email.fill('existing@example.invalid')
  await page.getByRole('button', { name: '发送验证码' }).click()
  await page.getByRole('link', { name: '用此邮箱登录' }).click()
  await expect(page.getByLabel('用户名或邮箱')).toHaveValue(
    'existing@example.invalid',
  )
})
