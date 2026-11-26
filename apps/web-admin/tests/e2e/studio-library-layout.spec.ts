import { expect, test } from '@playwright/test'
import { installParityFixture } from '../parity/ui-fixture'
import { captureDesign } from './design-capture'
import { studioProposalFixture } from '../fixtures/studio-proposal'

/** 用相同三条素材比较筛选栏和两种布局，避免把空列表误判为首屏可用。 */
test('四类素材目录的筛选、矮屏首条与手机紧凑列表', async ({ page }) => {
  await installParityFixture(page, {
    bothProducts: true,
    permissions: ['studio.assets.write', 'studio.projects.write'],
  })
  const example = studioProposalFixture().project.assets[0]!
  const kinds = new Map([
    ['media', 'image'],
    ['characters', 'character'],
    ['scenes', 'scene'],
    ['props', 'prop'],
  ])
  await page.route('**/api/studio/library?**', async (route) => {
    const query = new URL(route.request().url()).searchParams
    const items = ['海边暮色', '城市天际线', '清晨远景']
      .map((name, index) => ({
        ...example,
        name,
        id: String(index),
        family: String(index),
        version: 1,
        kind: kinds.get(query.get('category')!),
        project: null,
        fileId: null,
      }))
      .filter((asset) => asset.name.includes(query.get('search') || ''))
    await route.fulfill({ json: { items, total: items.length } })
  })
  for (const directory of ['characters', 'environments', 'props', 'library']) {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/#/entertainment/' + directory)
    const bar = page.getByRole('search')
    await expect(
      bar.getByRole('combobox', { name: '素材归档状态' }),
    ).toBeVisible()
    expect((await bar.boundingBox())!.height).toBeLessThanOrEqual(48)
    const tabs = await page.getByRole('tablist').boundingBox()
    expect(
      (await bar.boundingBox())!.y - tabs!.y - tabs!.height,
    ).toBeLessThanOrEqual(25)
  }
  const bar = page.getByRole('search')
  await bar.getByText('全部媒体', { exact: true }).click()
  await page.getByRole('option', { name: '图片', exact: true }).click()
  await bar.getByRole('textbox').fill('没有这个名称')
  await bar.getByRole('textbox').press('Enter')
  await expect(
    page.getByRole('heading', { name: '没有找到匹配素材' }),
  ).toBeVisible()
  await bar.getByRole('textbox').fill('')
  await bar.getByRole('button', { name: '搜索' }).click()
  const first = page.locator('.library-card').first()
  await expect(page.locator('.library-card')).toHaveCount(3)
  await page.setViewportSize({ width: 1280, height: 600 })
  await expect(first.getByRole('heading')).toBeInViewport({ ratio: 1 })
  await captureDesign(page, 'media-library-short-window.png')
  for (const width of [1440, 1280, 768, 390]) {
    await page.setViewportSize({ width, height: 844 })
    await bar.getByText('列表', { exact: true }).click()
    await expect(
      bar.getByRole('radio', { name: '列表', exact: true }),
    ).toBeChecked()
    await expect(first.getByRole('heading')).toBeInViewport({ ratio: 1 })
    const cover = await first.locator('.library-card-cover').boundingBox()
    const title = await first.getByRole('heading').boundingBox()
    expect(cover!.x + cover!.width).toBeLessThanOrEqual(title!.x)
    expect((await first.boundingBox())!.height).toBeLessThan(180)
    expect(
      await page
        .locator('main')
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true)
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await captureDesign(
        page,
        `media-library-list-${width}-${colorScheme}.png`,
      )
    }
  }
  await bar.getByText('卡片', { exact: true }).click()
  expect(
    (await first.locator('.library-card-cover').boundingBox())!.width,
  ).toBeGreaterThan(240)
  await page.getByRole('tab', { name: '作品中的素材' }).click()
  await expect(bar.getByRole('combobox', { name: '素材归档状态' })).toHaveCount(
    0,
  )
})
