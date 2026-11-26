import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { loginIsolatedAccount } from './live-auth'
import { captureDesign } from './design-capture'

/** 独立平台真实办理，覆盖会员、延期与用户管理行内入账，再用本人身份核对。 */
test('运营开通、续期和加额在本人账本生效', async ({
  page,
  request,
  browser,
}) => {
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
      roles: ['member', 'entertainment_creator'],
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
  await page.goto('/#/account/membership?product=office')
  await expect(page.getByText('无限额度', { exact: true })).toBeVisible()
  for (const product of ['office', 'entertainment']) {
    await page.goto('/#/product/members?product=' + product)
    const member = page.getByRole('row').filter({ hasText: username })
    await expect(
      member.getByRole('button', { name: '加额度', exact: true }),
    ).toBeVisible()
    await expect(
      member.getByRole('button', { name: '发额度卡', exact: true }),
    ).toBeVisible()
    await expect(
      member.getByRole('button', { name: '发放会员', exact: true }),
    ).toBeVisible()
  }
  const row = page.getByRole('row').filter({ hasText: username })
  await row.getByRole('button', { name: '发放会员', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: '会员办理' })
  await expect(dialog.getByLabel('办理方式')).toHaveValue('complimentary')
  await dialog.getByLabel('办理商品').selectOption('light-1')
  await dialog.getByLabel('办理原因').fill('内测开通')
  await dialog.getByRole('button', { name: '预览办理' }).click()
  await expect(dialog.getByText('赠送会员', { exact: true })).toBeVisible()
  await expect(dialog.getByText('¥0', { exact: true })).toBeVisible()
  await expect(dialog.getByText('0 → 300')).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await captureDesign(page, 'manual-preview-390.png')
  await dialog.getByRole('button', { name: '确认办理' }).click()
  await expect(row.getByText('可用 300', { exact: true })).toBeVisible()
  await row.getByRole('button', { name: '续期', exact: true }).click()
  await dialog.getByLabel('办理原因').fill('提前续期')
  await dialog.getByRole('button', { name: '预览办理' }).click()
  await expect(dialog.getByText('300 → 300')).toBeVisible()
  await dialog.getByRole('button', { name: '确认办理' }).click()
  await expect(dialog).toBeHidden()
  await page.goto('/#/billing/subscriptions?userId=' + userId)
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
  await expect(row.getByRole('button', { name: '加额度' })).toBeVisible()
  await page.goto('/#/product/members?product=office')
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
  await page
    .getByRole('navigation', { name: '平台导航' })
    .getByRole('link', { name: '额度卡管理', exact: true })
    .click()
  await expect(
    page.getByRole('heading', { name: '额度卡管理', exact: true }),
  ).toBeVisible()
  await page.getByRole('textbox', { name: '搜索账号' }).fill(username)
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await row.getByRole('button', { name: '发额度卡' }).click()
  dialog = page.getByRole('dialog', { name: '发放额度卡' })
  await dialog.getByLabel('卡面额').selectOption('500')
  await expect(dialog.getByLabel('卡面额').locator('option')).toHaveCount(5)
  await dialog.getByLabel('办理原因').fill('测试用额度卡')
  await dialog.getByRole('button', { name: '预览办理' }).click()
  await expect(dialog.getByText('580 → 1080')).toBeVisible()
  await dialog.getByRole('button', { name: '确认办理' }).click()
  await expect(dialog).toBeHidden()
  for (const [width, theme] of [
    [390, 'light'],
    [768, 'dark'],
    [1280, 'light'],
    [1440, 'dark'],
  ] as const) {
    await page.setViewportSize({ width, height: width === 1280 ? 560 : 844 })
    await page.emulateMedia({ colorScheme: theme })
    await expect(row.getByRole('button', { name: '查看额度卡' })).toBeVisible()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
    await captureDesign(page, 'card-directory-' + width + '.png')
  }
  await row.getByRole('button', { name: '查看额度卡' }).click()
  const cards = page.getByRole('dialog', { name: '查看额度卡 · ' + username })
  await expect(cards.getByText('可抵扣 500 点', { exact: true })).toBeVisible()
  await cards.getByRole('button', { name: '关闭', exact: true }).last().click()
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
  ).toBe(1080)
  expect(
    (
      await request.get('/api/admin/billing/subscriptions', { headers: own })
    ).status(),
  ).toBe(403)
  expect(
    (
      await request.get('/api/admin/billing/accounts/' + userId + '/cards', {
        headers: own,
      })
    ).status(),
  ).toBe(403)
  for (const product of ['office', 'entertainment']) {
    const url = '/api/navigation?product=' + product
    const memberMenus = (
      await (await request.get(url, { headers: own })).json()
    ).items.map((i: { id: string }) => i.id)
    expect(memberMenus).toContain('account.cards')
    expect(memberMenus).not.toContain('billing.cards')
    expect((await (await request.get(url, { headers })).json()).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'billing.cards',
          parentId: 'product-management',
        }),
      ]),
    )
  }
  const grantAttempt = await request.post(
    '/api/admin/billing/operation-previews',
    {
      headers: own,
      data: {
        action: 'card',
        points: 500,
        validDays: 1,
        userId,
        businessKey: randomUUID(),
        reason: '越权测试',
      },
    },
  )
  expect(grantAttempt.status()).toBe(403)
  expect(
    (await (await request.get('/api/me/billing/cards', { headers })).json())
      .items,
  ).toHaveLength(0)
  // 独立浏览器上下文模拟成员本人，不继承运营端的内存凭据和活动会话。
  const context = await browser.newContext({
    baseURL: process.env.WEB_ADMIN_E2E_BASE_URL,
  })
  try {
    const memberPage = await context.newPage()
    expect(
      (
        await loginIsolatedAccount(context.request, username, pass, 'browser')
      ).ok(),
    ).toBe(true)
    await memberPage.goto('/#/account/membership?product=entertainment')
    await memberPage
      .getByRole('navigation', { name: '平台导航' })
      .getByRole('link', { name: '我的额度卡', exact: true })
      .click()
    await expect(
      memberPage.getByRole('heading', { name: '我的额度卡' }),
    ).toBeVisible()
    await expect(
      memberPage.getByText('可抵扣 500 点', { exact: true }),
    ).toBeVisible()
    await memberPage.goto('/#/account/membership')
    await expect(
      memberPage.getByRole('heading', { name: '轻享会员', exact: true }),
    ).toBeVisible()
    await memberPage.getByRole('tab', { name: '我的额度卡' }).click()
    await expect(
      memberPage.getByText('500 点额度卡', { exact: true }),
    ).toBeVisible()
    await expect(
      memberPage.getByText('可抵扣 500 点', { exact: true }),
    ).toBeVisible()
    for (const width of [390, 768, 1280, 1440]) {
      await memberPage.setViewportSize({ width, height: 844 })
      await captureDesign(memberPage, 'credit-cards-' + width + '.png')
      expect(
        await memberPage.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true)
    }
    await memberPage.getByRole('button', { name: '选购会员' }).click()
    await expect(
      memberPage.getByRole('heading', { name: '套餐与加购' }),
    ).toBeVisible()
    const billingWrites: string[] = []
    memberPage.on('request', (req) => {
      if (
        req.method() !== 'GET' &&
        /billing|order|payment/i.test(new URL(req.url()).pathname)
      )
        billingWrites.push(req.url())
    })
    await memberPage.getByRole('button', { name: /创作会员/ }).click()
    await memberPage
      .getByRole('button', { name: '购买会员', exact: true })
      .click()
    const contact = memberPage.getByRole('dialog', { name: '联系管理员' })
    await expect(
      contact.getByText('支付功能暂未开通，请联系管理员获取会员。'),
    ).toBeVisible()
    await expect(contact.getByText('创作会员 · ¥69 · 800 创作点')).toBeVisible()
    const code = contact.getByRole('img', { name: '管理员微信二维码' })
    await expect
      .poll(() => code.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBe(972)
    for (const width of [390, 768, 1280, 1440]) {
      await memberPage.emulateMedia({
        colorScheme: width === 768 || width === 1440 ? 'dark' : 'light',
      })
      await memberPage.setViewportSize({
        width,
        height: width === 1280 ? 600 : 844,
      })
      await expect(code.locator('..')).toBeInViewport({ ratio: 1 })
      await expect(
        contact.getByRole('link', { name: '保存二维码' }),
      ).toBeInViewport()
      await captureDesign(memberPage, 'membership-contact-' + width + '.png')
    }
    const [download] = await Promise.all([
      memberPage.waitForEvent('download'),
      contact.getByRole('link', { name: '保存二维码' }).click(),
    ])
    expect(download.suggestedFilename()).toBe('星桥会员管理员微信.jpg')
    expect(await download.failure()).toBeNull()
    await memberPage.keyboard.press('Escape')
    await expect(contact).toBeHidden()
    await memberPage
      .getByRole('button', { name: /加购包/ })
      .first()
      .click()
    await memberPage
      .getByRole('button', { name: '购买加购包', exact: true })
      .click()
    await expect(
      contact.getByText('支付功能暂未开通，请联系管理员办理额度加购。'),
    ).toBeVisible()
    await expect(contact.getByText('加购包 · ¥19 · 180 创作点')).toBeVisible()
    await contact
      .getByRole('button', { name: '关闭', exact: true })
      .last()
      .click()
    await expect(contact).toBeHidden()
    expect(billingWrites).toEqual([])
    const wallet = await request.get('/api/me/billing', { headers: own })
    expect(await wallet.json()).toMatchObject({
      availablePoints: 1080,
      subscription: { plan: { sku: 'light' } },
    })
  } finally {
    await context.close()
  }
})
