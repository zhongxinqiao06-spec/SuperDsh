import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { captureDesign } from './design-capture'
import { loginIsolatedAccount } from './live-auth'

async function signIn(page: Page, username: string, password: string) {
  await page.goto('/#/login')
  await page.getByLabel('用户名或邮箱').fill(username)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录 ↵', exact: true }).click()
  await page.waitForURL((url) => !url.hash.startsWith('#/login'))
}

/** 先办理两个原档周期，再从运营及会员两端核对预约、办理和撤回。 */
test('预约从首个未购周期开始，已购换档撤销后可恢复原档', async ({
  page,
  request,
  browser,
  baseURL,
}) => {
  test.skip(process.env.WEB_ADMIN_E2E_LIVE !== '1', '仅运行于隔离后端')
  test.setTimeout(120_000)
  const admin = process.env.WEB_ADMIN_E2E_USERNAME ?? 'foundation-admin'
  const password = process.env.WEB_ADMIN_E2E_PASSWORD!
  const login = await loginIsolatedAccount(request, admin, password)
  const headers = {
    authorization: 'Bearer ' + (await login.json()).accessToken,
  }
  const username = 'tier-' + randomUUID().slice(0, 10),
    pass = randomUUID() + '!'
  const user = await request.post('/api/admin/users', {
    headers,
    data: {
      username,
      displayName: '周期核对账号',
      password: pass,
      roles: ['member'],
    },
  })
  expect(user.status()).toBe(201)
  const userId = (await user.json()).userId
  const path = '/api/admin/billing/subscriptions'
  for (const action of ['open', 'renew']) {
    const preview = await request.post(
      '/api/admin/billing/operation-previews',
      {
        headers,
        data: {
          businessKey: randomUUID(),
          userId,
          action,
          planVersionId: 'light-1',
          reason: '合成既有已购周期',
          payment: 'offline',
          receivedFen: 2900,
          receipt: randomUUID(),
        },
      },
    )
    expect(preview.ok()).toBe(true)
    const result = await request.post(path, {
      headers,
      data: { previewId: (await preview.json()).id },
    })
    expect(result.ok()).toBe(true)
  }
  const readAccount = async () =>
    (await (await request.get(path, { headers, params: { userId } })).json())
      .items[0]
  const original = await readAccount()
  await signIn(page, admin, password)
  await page.goto('/#/billing/subscriptions?userId=' + userId)
  const row = page.getByRole('row').filter({ hasText: username })
  await row.getByRole('button', { name: '预约换档' }).click()
  let dialog = page.getByRole('dialog', { name: '预约换档' })
  await dialog.getByLabel('目标档位').selectOption('creator-1')
  await expect(dialog.getByRole('button', { name: '确认预约' })).toBeDisabled()
  await dialog.getByLabel('预约原因').fill('验证首个未购周期')
  for (const [width, colorScheme] of [
    [390, 'light'],
    [768, 'dark'],
    [1280, 'light'],
    [1440, 'dark'],
  ] as const) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.emulateMedia({ colorScheme })
    await expect(
      dialog.getByRole('button', { name: '确认预约' }),
    ).toBeInViewport()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
    await captureDesign(page, 'change-schedule-' + width + '.png')
  }
  await dialog.getByRole('button', { name: '确认预约' }).click()
  await expect(row.getByText(/已预约，待办理/)).toBeVisible()
  expect((await readAccount()).planChange.effectiveAt).toBe(original.endsAt)
  await row.getByRole('button', { name: '撤销预约' }).click()
  dialog = page.getByRole('dialog', { name: '撤销换档预约' })
  await dialog.getByLabel('撤销原因').fill('客户暂缓')
  await dialog.getByRole('button', { name: '确认撤销' }).click()
  await expect(row.getByRole('button', { name: '预约换档' })).toBeVisible()
  await row.getByRole('button', { name: '预约换档' }).click()
  dialog = page.getByRole('dialog', { name: '预约换档' })
  await dialog.getByLabel('目标档位').selectOption('creator-1')
  await dialog.getByLabel('预约原因').fill('客户确认')
  await dialog.getByRole('button', { name: '确认预约' }).click()
  await expect(row.getByText(/已预约，待办理/)).toBeVisible()
  await row.getByRole('button', { name: '续期', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '会员办理' })
  await expect(dialog.getByLabel('办理商品')).toHaveValue('creator-1')
  await dialog.getByLabel('办理方式').selectOption('offline')
  await dialog.getByLabel('收款凭证号').fill(randomUUID())
  await dialog.getByLabel('实收金额（元）').fill('69')
  await dialog.getByLabel('办理原因').fill('合成线下续期')
  await dialog.getByRole('button', { name: '预览办理' }).click()
  await expect(dialog.getByText('300 → 300')).toBeVisible()
  await dialog.getByRole('button', { name: '确认办理' }).click()
  await expect(row.getByText(/已办理，待周期开始/)).toBeVisible()
  const booked = await readAccount()
  expect(booked.lastBookedSku).toBe('creator')
  const first = await loginIsolatedAccount(request, username, pass)
  expect(
    (
      await request.post('/api/auth/change-password', {
        headers: {
          authorization: 'Bearer ' + (await first.json()).accessToken,
        },
        data: { newPassword: pass },
      })
    ).status(),
  ).toBe(204)
  const memberPage = await browser.newPage({
    baseURL,
    viewport: { width: 390, height: 844 },
  })
  try {
    await signIn(memberPage, username, pass)
    await memberPage.goto('/#/account/membership')
    await expect(memberPage.getByText(/轻享会员 → 创作会员/)).toBeVisible()
    await expect(memberPage.getByText(/已办理，待周期开始/)).toBeVisible()
    await captureDesign(memberPage, 'change-member-390.png')
    await page.goto(
      '/#/billing/subscriptions?userId=' + userId + '&product=entertainment',
    )
    await row.getByRole('button', { name: '撤销预约' }).click()
    dialog = page.getByRole('dialog', { name: '撤销换档预约' })
    await expect(dialog.getByText('最早恢复原档')).toBeVisible()
    await dialog.getByLabel('撤销原因').fill('下一未购周期恢复轻享')
    await page.setViewportSize({ width: 1280, height: 560 })
    await captureDesign(page, 'change-restore-short.png')
    await dialog.getByRole('button', { name: '确认撤销' }).click()
    await expect(row.getByText(/已预约，待办理.*轻享会员/)).toBeVisible()
    const restored = await readAccount()
    expect(restored.planChange.effectiveAt).toBe(booked.endsAt)
    expect(restored.availablePoints).toBe(300)
    await memberPage.getByRole('button', { name: '刷新', exact: true }).click()
    await expect(memberPage.getByText(/创作会员 → 轻享会员/)).toBeVisible()
    await expect(memberPage.getByText(/已购的下个档位.*创作会员/)).toBeVisible()
    await captureDesign(memberPage, 'change-restoration-member-390.png')
    await row.getByRole('button', { name: '办理记录' }).click()
    dialog = page.getByRole('dialog', { name: '历史办理' })
    await dialog.getByRole('tab', { name: '换档记录' }).click()
    await expect(dialog.getByText('客户暂缓', { exact: true })).toBeVisible()
    await expect(dialog.getByText('恢复原档对应预约')).toBeVisible()
    await captureDesign(page, 'change-history.png')
  } finally {
    await memberPage.close()
  }
})
