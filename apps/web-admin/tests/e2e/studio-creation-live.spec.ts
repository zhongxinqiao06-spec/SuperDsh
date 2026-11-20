import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { captureDesign } from './design-capture'

/** 真实隔离账号验证三条创建链路和作品库筛选恢复，全程只保存草稿。 */
test('从首页创建三种作品，从作品库恢复筛选和系列编辑位置', async ({ page }) => {
  test.skip(process.env.WEB_ADMIN_E2E_LIVE !== '1', '需要隔离后端')
  test.setTimeout(120_000)
  await page.goto('/#/login?returnTo=/entertainment', {
    waitUntil: 'domcontentloaded',
    timeout: 90_000,
  })
  await page
    .getByLabel('用户名或邮箱')
    .fill(process.env.WEB_ADMIN_E2E_USERNAME ?? 'foundation-admin')
  await page
    .getByLabel('密码', { exact: true })
    .fill(process.env.WEB_ADMIN_E2E_PASSWORD!)
  await page.getByRole('button', { name: '登录 ↵', exact: true }).click()
  const prefix = '创作验证-' + randomUUID().slice(0, 8)
  const links = page.getByRole('group', { name: '选择创作模式' })
  const nav = page.getByRole('navigation', { name: '平台导航' })
  await expect(links.getByRole('link')).toHaveCount(3)
  const home = nav.getByRole('link', { name: '首页', exact: true })
  await expect(home).toHaveAttribute('aria-current', 'page')
  await expect(nav.locator(':scope > :first-child')).toHaveAccessibleName(
    '首页',
  )
  const workspace = nav.getByRole('button', { name: '创作工作台' })
  await expect(workspace).toHaveAttribute('aria-expanded', 'true')
  await workspace.click()
  await expect(workspace).toHaveAttribute('aria-expanded', 'false')
  await expect(home).toBeInViewport()
  await workspace.click()
  await expect(
    nav.locator('.nav-children').getByRole('link', { name: '首页' }),
  ).toHaveCount(0)
  await captureDesign(page, 'creation-center.png')
  await page.setViewportSize({ width: 390, height: 844 })
  await captureDesign(page, 'creation-center-mobile.png')
  await page.getByRole('button', { name: '打开导航' }).click()
  const drawer = page.getByRole('dialog', { name: '平台导航' })
  await expect(
    drawer.getByRole('link', { name: '首页', exact: true }),
  ).toBeVisible()
  await captureDesign(page, 'creation-center-menu-mobile.png')
  await drawer.getByRole('link', { name: '首页', exact: true }).click()
  await expect(drawer).toBeHidden()
  await page.setViewportSize({ width: 1440, height: 1000 })
  await links.getByRole('link', { name: '快速创作' }).click()
  await page.getByLabel('快速作品名称').fill(prefix + '快速')
  await page.getByRole('button', { name: '保存草稿' }).click()
  await expect(page).toHaveURL(/\/quick\/(?!new$)[\w-]+$/)
  await nav.getByRole('link', { name: '首页' }).click()

  await links.getByRole('link', { name: '分镜创作' }).click()
  await page.getByLabel('作品名称', { exact: true }).fill(prefix + '分镜')
  await page.getByRole('button', { name: '创建并编辑故事' }).click()
  await expect(page.getByLabel('剧本正文')).toBeVisible()
  await nav.getByRole('link', { name: '首页' }).click()

  await links.getByRole('link', { name: '系列短剧' }).click()
  await page.getByLabel('作品名称', { exact: true }).fill(prefix + '短剧')
  await page.getByLabel('初始集数').fill('2')
  await page.getByRole('button', { name: '创建并编排故事' }).click()
  await expect(page).toHaveURL(/\/series\/[\w-]+\?section=episodes$/)
  await nav.getByRole('link', { name: '我的作品' }).click()
  const search = page.getByLabel('搜索作品名称')
  await search.fill(prefix)
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  const cards = page.getByLabel('作品项目')
  await expect(cards.locator('article')).toHaveCount(3)
  const series = page.getByRole('tab', { name: '系列短剧' })
  await series.click()
  await expect(cards.locator('article')).toHaveCount(1)
  await expect(cards.getByText('编排分集', { exact: false })).toBeVisible()
  await cards.getByRole('link', { name: prefix + '短剧', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: prefix + '短剧' }),
  ).toBeVisible()
  await page.getByRole('link', { name: '← 我的作品' }).click()
  await expect(search).toHaveValue(prefix)
  await expect(series).toHaveAttribute('aria-selected', 'true')
  await expect(cards.locator('article')).toHaveCount(1)
})
