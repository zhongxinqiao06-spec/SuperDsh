import { expect, test } from '@playwright/test'
import { installFoundationFixture } from './foundation-fixture'

/** 合成异常及多页流水，核对游标、筛选切换、空账户和恢复入口。 */
test('个人额度分页、筛选与失败重试', async ({ page }) => {
  const identity = await installFoundationFixture(page)
  identity.signedIn = true
  const now = '2026-11-24T12:00:00Z'
  let attempts = 0
  await page.route('**/api/me/billing', async (route) => {
    if (++attempts === 1)
      return route.fulfill({
        status: 503,
        json: { detail: '暂时无法读取账本' },
      })
    return route.fulfill({
      json: {
        asOf: now,
        availablePoints: 0,
        heldPoints: 0,
        expiringPoints: 0,
        expiringDays: 7,
        subscription: null,
        lots: [],
        hasMoreLots: false,
      },
    })
  })
  await page.route('**/api/me/billing/entries?**', (route) => {
    const query = new URL(route.request().url()).searchParams
    const cursor = query.get('cursor')
    const item = {
      id: cursor ? 'older' : 'recent',
      kind: 'registration_grant',
      createdAt: now,
      availableDelta: cursor ? 20 : 40,
      heldDelta: 0,
    }
    return route.fulfill({
      json: {
        items: query.has('since') ? [] : [item],
        nextCursor: cursor || query.has('since') ? null : item.id,
      },
    })
  })
  await page.goto('/#/account/membership')
  await page.getByRole('button', { name: '重试' }).click()
  await expect(
    page.getByRole('heading', { name: '尚未开通会员' }),
  ).toBeVisible()
  await expect(page.getByText('可用 +40', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '下一页' }).click()
  await expect(page.getByText('可用 +20', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '上一页' }).click()
  await expect(page.getByText('可用 +40', { exact: true })).toBeVisible()
  await page.getByRole('combobox', { name: '时间范围' }).press('Enter')
  await page.getByRole('option', { name: '近 7 天' }).click()
  await expect(page.getByText('暂无符合条件的流水')).toBeVisible()
  await expect(page.getByRole('button', { name: '上一页' })).toBeDisabled()
  await page.getByRole('tab', { name: '来源批次' }).click()
  await expect(page.getByText('没有可用或占用中的额度批次')).toBeVisible()
})
