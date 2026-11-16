import { readFile } from 'node:fs/promises'
import { test, expect, type Page } from '@playwright/test'
import { installFoundationFixture } from './foundation-fixture'

const products = ['products.office', 'products.entertainment']
async function expectNoOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true)
}

test('匿名访客切镜、切换产品并核对 CSV，刷新与历史可续接', async ({ page }) => {
  const state = await installFoundationFixture(page)
  await page.goto('/#/website')
  const productsNav = page.getByRole('navigation', { name: '浏览产品' })
  const office = productsNav.getByRole('link', { name: '星桥办公' })
  const preview = page.getByRole('region', { name: '雨后站台分镜预览' })
  await expect(preview.locator('.preview-view img')).toHaveAttribute(
    'src',
    '/images/website/film.webp',
  )
  await preview.getByRole('button', { name: /雨棚/ }).press('Enter')
  await expect(preview.locator('.preview-meta')).toContainText(
    '镜头 03 · 雨棚中景',
  )
  await expect(preview.locator('.preview-meta')).toContainText('00:07 – 00:12')
  await expect(preview.locator('.preview-view img')).toHaveAttribute(
    'src',
    '/images/website/shot-3.webp',
  )
  await office.click()
  await expect(office).toHaveAttribute('aria-current', 'page')
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('简报')
  const table = page.getByRole('table').first()
  await expect(table.getByRole('row').last()).toContainText('48.4')
  const downloaded = page.waitForEvent('download')
  await page.getByRole('link', { name: '下载示例 CSV' }).click()
  const file = await downloaded
  const csv = await readFile((await file.path())!, 'utf8')
  const totals = new Map<string, number>()
  for (const row of csv.trim().split(/\r?\n/).slice(1)) {
    const [month, , revenue] = row.split(',')
    totals.set(month!, (totals.get(month!) ?? 0) + Number(revenue))
  }
  for (const [i, value] of [...totals.values()].entries())
    await expect(
      table.locator('tbody tr').nth(i).locator('td').last(),
    ).toHaveText((value / 10000).toFixed(1))
  await expect(page.locator('.report-stat')).toContainText(
    (Array.from(totals.values()).reduce((a, b) => a + b) / 10000).toFixed(1),
  )
  await page.goBack()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('短片')
  await page.goForward()
  await page.getByRole('button', { name: '打开导航' }).click()
  await page.getByRole('button', { name: 'English' }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'editable',
  )
  await expect(page.getByRole('link', { name: 'Privacy notice' })).toBeVisible()
  expect(state.requests).toEqual([])
})

for (const theme of ['light', 'dark']) {
  test(`双产品首页与系统选择在四档宽度和 ${theme} 下均可操作`, async ({
    page,
  }, info) => {
    await page.addInitScript(
      (value) => localStorage.setItem('starbridge.theme', value),
      theme,
    )
    const session = await installFoundationFixture(page, products)
    session.signedIn = true
    await page.emulateMedia({ reducedMotion: 'reduce' })
    for (const path of ['/', '/?product=office', '/products']) {
      await page.goto('/#' + path)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      for (const width of [390, 768, 1280, 1440]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 960 })
        await expectNoOverflow(page)
        if (path === '/')
          await expect(
            page.getByRole('link', { name: '进入创作台' }),
          ).toHaveCSS('transition-duration', '0s')
        if (path === '/products') {
          const links = page.locator('.workspace-choices a')
          await expect(links).toHaveCount(2)
          const studio = await links.first().boundingBox()
          const office = await links.last().boundingBox()
          expect(
            width === 390 ? studio!.y < office!.y : studio!.x < office!.x,
          ).toBe(true)
          await links.first().focus()
          await expect(links.first()).toBeFocused()
        }
        if (width === 390 || width === 1440) {
          await page.evaluate(async () => {
            await Promise.all(
              [
                ...document.querySelectorAll<HTMLImageElement>(
                  'main img:not([loading=lazy])',
                ),
              ].map((img) => img.decode()),
            )
            await document.fonts.ready
          })
          await page.screenshot({
            path: info.outputPath(
              `${path === '/products' ? 'launch' : path === '/' ? 'studio' : 'office'}-${theme}-${width}.png`,
            ),
            animations: 'disabled',
          })
        }
      }
    }
  })
}

for (const [product, label] of [
  ['entertainment', '进入创作台'],
  ['office', '进入办公台'],
] as const) {
  test(`${label}使用密码登录后回到指定产品`, async ({ page }) => {
    const state = await installFoundationFixture(page, products)
    await page.goto('/#/?product=' + product)
    await page.getByRole('link', { name: label, exact: true }).click()
    await expect(page.getByLabel('用户名或邮箱')).toBeVisible()
    await page.getByLabel('用户名或邮箱').fill('synthetic')
    await page.getByLabel('密码', { exact: true }).fill('Synthetic-password!')
    await page.getByRole('button', { name: '登录 ↵' }).click()
    await expect(page).toHaveURL(new RegExp('#/' + product + '$'))
    expect(state.signedIn).toBe(true)
  })
}

test('第三方登录回到双产品选择，显式产品目的地优先', async ({ page }) => {
  const state = await installFoundationFixture(page, products)
  await page.route('**/api/auth/oauth/finalize', async (route) => {
    state.signedIn = true
    await route.fulfill({
      json: {
        userId: 'fixture-admin',
        displayName: '合成用户',
        role: 'member',
        roles: ['member'],
        permissions: products,
        authzVersion: 1,
        accessToken: 'fixture-token',
        tokenType: 'bearer',
      },
    })
  })
  await page.goto('/login?oauth_status=authenticated&oauth_pending=synthetic')
  await expect(page.getByRole('heading', { name: '选择工作台' })).toBeVisible()
  state.signedIn = false
  await page.goto(
    '/login?oauth_status=authenticated&oauth_pending=synthetic&returnTo=%2Foffice',
  )
  await expect(page).toHaveURL(/#\/office$/)
})
