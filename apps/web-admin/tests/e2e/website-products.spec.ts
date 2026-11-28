import { readFile } from 'node:fs/promises'
import { test, expect, type Page } from '@playwright/test'
import { installFoundationFixture } from './foundation-fixture'

const products = ['products.office', 'products.entertainment']

for (const product of ['entertainment', 'office'] as const) {
  test(`从 ${product} 官网经选择工作台或隐私说明注册保留入口`, async ({
    page,
  }) => {
    await installFoundationFixture(page)
    await page.route('**/api/auth/config', (route) =>
      route.fulfill({
        json: { registrationOpen: true, registrationEmailAvailable: true },
      }),
    )
    for (const entry of ['选择工作台', '隐私说明']) {
      await page.goto(
        product === 'entertainment' ? '/#/' : '/#/?product=office',
      )
      if (product === 'entertainment' || entry === '隐私说明')
        await page.getByRole('button', { name: '打开导航' }).click()
      await page
        .locator('.masthead')
        .getByRole('link', { name: entry, exact: true })
        .click()
      if (entry === '隐私说明')
        await page.getByRole('link', { name: '返回登录' }).click()
      await page.getByRole('link', { name: '去注册', exact: true }).click()
      await page.reload()
      await expect(page.locator('.login-intro--registration')).toContainText(
        product === 'entertainment'
          ? '星桥娱乐 · 创作者账号'
          : '星桥办公 · 办公账号',
      )
    }
  })
}

for (const theme of ['light', 'dark']) {
  test(`娱乐五屏在 ${theme} 下可翻页、预览，并完整容纳各档内容`, async ({
    page,
  }, info) => {
    test.setTimeout(90_000)
    await page.addInitScript(
      (value) => localStorage.setItem('starbridge.theme', value),
      theme,
    )
    await installFoundationFixture(page)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('/#/')
    const chapterNav = page.getByRole('navigation', { name: '章节导航' })
    const names = ['灵感开场', '创作类型', '制作流程', '创作优势', '开始创作']
    for (const [width, height] of [
      [390, 844],
      [768, 960],
      [1280, 600],
      [1440, 960],
    ]) {
      await page.setViewportSize({ width: width!, height: height! })
      for (const [index, name] of names.entries()) {
        await chapterNav.getByRole('button', { name, exact: true }).click()
        await expect(
          chapterNav.getByRole('button', { name, exact: true }),
        ).toHaveAttribute('aria-current', 'step')
        const chapter = page.locator('[data-chapter]').nth(index)
        const root = await page.locator('.studio-pages').boundingBox()
        const bounds = await chapter.boundingBox()
        expect(Math.abs(bounds!.y - root!.y)).toBeLessThan(2)
        await expectNoOverflow(page)
        expect(
          await chapter.evaluate(
            (element) => element.scrollWidth <= element.clientWidth,
          ),
        ).toBe(true)
        await chapter.locator('img').evaluateAll(async (images) => {
          await Promise.all(
            images.map((img) => (img as HTMLImageElement).decode()),
          )
        })
        if (width === 1440 || width === 390) {
          await page.screenshot({
            path: info.outputPath(`chapter-${index + 1}-${theme}-${width}.png`),
            animations: 'disabled',
          })
        }
      }
    }
    await chapterNav
      .getByRole('button', { name: '灵感开场', exact: true })
      .click()
    await page.locator('#studio-intro').press('PageDown')
    await expect(
      chapterNav.getByRole('button', { name: '创作类型', exact: true }),
    ).toHaveAttribute('aria-current', 'step')
    await page.locator('#studio-creations').press('Home')
    const image = page.getByRole('button', { name: '查看故事短片画面' })
    await image.click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).not.toBeVisible()
    await expect(image).toBeFocused()
    await chapterNav
      .getByRole('button', { name: '创作优势', exact: true })
      .click()
    const comparison = page.getByRole('group', { name: '候选画面对比示意' })
    await comparison.getByRole('button').first().click()
    await expect(comparison.getByRole('button').first()).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(comparison.getByRole('button').last()).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(errors).toEqual([])
  })
}
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
  const preview = page.getByRole('region', { name: '雨后站台分镜预览' })
  await expect(preview.locator('.preview-view img')).toHaveAttribute(
    'src',
    '/images/website/shot-2.webp',
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
  await page.getByRole('button', { name: '打开导航' }).click()
  await page
    .getByRole('navigation', { name: '官网导航' })
    .getByRole('link', { name: '星桥办公' })
    .click()
  const office = page
    .getByRole('navigation', { name: '浏览产品' })
    .getByRole('link', { name: '星桥办公' })
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
  await expect(page.getByRole('heading', { level: 1 })).toContainText('让想象')
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
