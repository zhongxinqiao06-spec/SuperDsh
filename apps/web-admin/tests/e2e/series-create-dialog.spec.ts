import { expect, test, type Page } from '@playwright/test'
import { installFoundationFixture } from './foundation-fixture'
import { captureDesign } from './design-capture'
import type {
  SeriesBrief,
  StudioSeries,
} from '../../fronted/src/types/studio/series'

/** 全部接口为内存契约替身；只验证弹窗交互，不连接用户数据库或模型供应商。 */
async function installSeriesDialogFixture(page: Page, readonly = false) {
  const state = await installFoundationFixture(page, [
    'products.entertainment',
    'studio.projects.read',
    ...(!readonly ? ['studio.projects.write'] : []),
  ])
  state.signedIn = true
  const attempts: (SeriesBrief & {
    requestKey: string
    createEpisodeDrafts: boolean
  })[] = []
  let release: (() => void) | undefined
  let series: StudioSeries | undefined
  let rejected = true
  await page.route('**/api/studio/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/studio/creation-defaults')
      return route.fulfill({
        json: {
          aspectWidth: 9,
          aspectHeight: 16,
          targetDurationMs: 60000,
          language: 'zh-CN',
        },
      })
    if (path === '/api/studio/works' || path === '/api/studio/jobs')
      return route.fulfill({
        json: { total: 0, items: [], page: 1, pageSize: 10 },
      })
    if (path === '/api/studio/series' && request.method() === 'POST') {
      const body = request.postDataJSON() as (typeof attempts)[number]
      attempts.push(structuredClone(body))
      if (rejected) {
        rejected = false
        return route.fulfill({
          status: 503,
          json: { detail: '合成测试：暂时无法保存，请重试。' },
        })
      }
      await new Promise<void>((resolve) => {
        release = resolve
      })
      series = {
        ...body,
        id: 'synthetic-series',
        revision: 1,
        lifecycle: 'active',
        updated: '2026-11-19T00:00:00Z',
        settingsRevision: 1,
        settings: [],
        episodes: [],
        episodeCount: 0,
        deliveredCount: 0,
        currentEpisodeId: null,
        archivedEpisodes: [],
      }
      return route.fulfill({ json: series })
    }
    if (
      path === '/api/studio/series/synthetic-series' &&
      request.method() === 'GET'
    )
      return route.fulfill({ json: series })
    return route.fallback()
  })
  return { state, attempts, release: () => release?.() }
}

const dialogFor = (page: Page) =>
  page.getByRole('dialog', { name: '新建系列短剧', exact: true })
async function openFromDirectory(page: Page) {
  await page.getByRole('button', { name: '新建作品', exact: true }).click()
  await page.getByRole('menuitem', { name: /系列短剧/ }).click()
  await expect(dialogFor(page)).toBeVisible()
  await expect(
    dialogFor(page).getByLabel('主要语言', { exact: true }),
  ).toHaveValue('zh-CN')
}

for (const theme of ['light', 'dark']) {
  test(`新建系列弹窗 ${theme}：四档布局、取消保稿、失败重试和提交去重`, async ({
    page,
  }) => {
    test.setTimeout(180_000)
    await page.addInitScript(
      (value) => localStorage.setItem('starbridge.theme', value),
      theme,
    )
    const fixture = await installSeriesDialogFixture(page)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    // 旧收藏入口仍可用，但背景已是作品目录，不再出现独立的新建页面。
    await page.goto('/#/entertainment', {
      waitUntil: 'domcontentloaded',
      timeout: 90_000,
    })
    await expect(
      page.getByRole('heading', { name: '我的作品', exact: true }),
    ).toBeVisible({ timeout: 30_000 })
    await page.goto('/#/entertainment/series/new', {
      waitUntil: 'domcontentloaded',
      timeout: 90_000,
    })
    const dialog = dialogFor(page)
    await expect(dialog).toBeVisible()
    await expect(
      page.getByRole('heading', { name: '我的作品', exact: true }),
    ).toBeVisible()
    await expect(page).toHaveURL(/\/entertainment(?:\?[^#]*)?$/)
    await expect(dialog.getByLabel('主要语言', { exact: true })).toHaveValue(
      'zh-CN',
    )
    await expect(
      dialog.getByRole('button', { name: '创建并编排故事', exact: true }),
    ).toBeDisabled()
    await expect(dialog.getByRole('radio', { name: /连续剧情$/ })).toBeChecked()

    for (const width of [390, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      // 等待开场/宽度适配动画结束后再取基准，避免将过渡位移误判为标题随正文滚动。
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document
                .getAnimations()
                .filter((animation) => animation.playState === 'running')
                .length,
          ),
        )
        .toBe(0)
      const body = dialog.locator('.el-dialog__body')
      await body.evaluate((element) => {
        element.scrollTop = 0
      })
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        )
        .toBe(true)
      const header = await dialog.locator('.el-dialog__header').boundingBox()
      const footer = await dialog.locator('.el-dialog__footer').boundingBox()
      const bounds = await dialog.boundingBox()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1)
      expect(footer!.y + footer!.height).toBeLessThanOrEqual(
        (width === 390 ? 844 : 1000) + 1,
      )
      await captureDesign(page, `series-create-${theme}-${width}-top.png`)
      const hasOverflow = await body.evaluate(
        (element) => element.scrollHeight > element.clientHeight + 1,
      )
      await body.evaluate((element) => {
        element.scrollTop = element.scrollHeight
      })
      if (hasOverflow)
        await expect
          .poll(() => body.evaluate((element) => element.scrollTop))
          .toBeGreaterThan(0)
      const afterHeader = await dialog
        .locator('.el-dialog__header')
        .boundingBox()
      const afterFooter = await dialog
        .locator('.el-dialog__footer')
        .boundingBox()
      expect(Math.abs(afterHeader!.y - header!.y)).toBeLessThanOrEqual(1)
      expect(Math.abs(afterFooter!.y - footer!.y)).toBeLessThanOrEqual(1)
      await expect(
        dialog.getByRole('spinbutton', { name: '初始集数', exact: true }),
      ).toBeInViewport()
      await captureDesign(page, `series-create-${theme}-${width}-bottom.png`)
    }

    // 只改初始集数，也必须被识别为未保存编辑；继续编辑不应丢失。
    const count = dialog.getByRole('spinbutton', {
      name: '初始集数',
      exact: true,
    })
    const initialCount = await count.inputValue()
    await count.fill('3')
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    const confirmation = page.getByRole('dialog', {
      name: '未保存的修改',
      exact: true,
    })
    await expect(confirmation).toBeVisible()
    await confirmation
      .getByRole('button', { name: '继续编辑', exact: true })
      .click()
    await expect(count).toHaveValue('3')
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await confirmation
      .getByRole('button', { name: '放弃修改', exact: true })
      .click()
    await expect(dialog).toBeHidden()
    await expect(page).toHaveURL(/\/entertainment$/)
    expect(fixture.attempts).toHaveLength(0)
    // 使用真实导航链接建立 Router 历史，检查返回不会卸载提交中的表单。
    await page.getByRole('link', { name: '制作任务', exact: true }).click()
    await expect(
      page.getByRole('heading', { name: '制作任务', exact: true }),
    ).toBeVisible()
    await page.getByRole('link', { name: '作品项目', exact: true }).click()
    await expect(
      page.getByRole('heading', { name: '我的作品', exact: true }),
    ).toBeVisible()
    await openFromDirectory(page)
    await expect(count).toHaveValue(initialCount)

    await dialog.getByLabel('作品名称', { exact: true }).fill('合成弹窗短剧')
    await dialog
      .getByLabel('故事构想', { exact: true })
      .fill('两只小狗追随一张旧星图，前往遥远的星球。')
    await count.fill('2')
    const submit = dialog.getByRole('button', {
      name: '创建并编排故事',
      exact: true,
    })
    await submit.click()
    await expect(dialog.locator('.el-alert--error')).toContainText(
      '暂时无法保存',
    )
    await expect(dialog.getByLabel('作品名称', { exact: true })).toHaveValue(
      '合成弹窗短剧',
    )
    await expect(count).toHaveValue('2')
    expect(fixture.attempts).toHaveLength(1)
    await captureDesign(page, `series-create-${theme}-failed.png`)
    await submit.click()
    await expect.poll(() => fixture.attempts.length).toBe(2)
    await expect(submit).toHaveClass(/is-loading/)
    // 点击与表单回车并发到达时仍只有一次请求；未知失败重试保留同一操作身份。
    await submit.evaluate((element) => (element as HTMLButtonElement).click())
    await dialog
      .locator('form')
      .evaluate((element) => (element as HTMLFormElement).requestSubmit())
    await expect(
      dialog.getByRole('button', { name: '取消', exact: true }),
    ).toBeDisabled()
    expect(fixture.attempts).toHaveLength(2)
    expect(fixture.attempts[1]).toEqual(fixture.attempts[0])
    expect(fixture.attempts[1]).toMatchObject({
      plannedEpisodes: 2,
      createEpisodeDrafts: true,
    })
    const pendingUrl = page.url()
    await page.goBack({ waitUntil: 'domcontentloaded' })
    await expect(page).toHaveURL(pendingUrl)
    await expect(dialog).toBeVisible()
    expect(fixture.attempts).toHaveLength(2)
    fixture.release()
    await expect(dialog).toBeHidden()
    await expect(page).toHaveURL(
      /\/entertainment\/series\/synthetic-series\?section=episodes$/,
    )
    await expect(
      page.getByRole('heading', { name: '合成弹窗短剧', exact: true }),
    ).toBeVisible()
    expect(errors).toEqual([])
    expect(
      fixture.state.requests.some((request) =>
        /generation|\/jobs|\/runtime/.test(request),
      ),
    ).toBe(false)
  })
}

test('只读账号不能通过新建系列旧链接绕过权限', async ({ page }) => {
  const fixture = await installSeriesDialogFixture(page, true)
  await page.goto('/#/entertainment/series/new', {
    waitUntil: 'domcontentloaded',
    timeout: 90_000,
  })
  await expect(
    page.getByRole('heading', { name: '我的作品', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: '新建作品', exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: '创建并编排故事', exact: true }),
  ).toHaveCount(0)
  expect(fixture.attempts).toHaveLength(0)
})
