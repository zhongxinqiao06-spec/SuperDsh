import { test, expect } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { installFoundationFixture } from './foundation-fixture'
import { studioProposalFixture } from '../fixtures/studio-proposal'

/** 合成方案覆盖三方阅读、覆盖确认和角色试听布局，不提交真实模型请求。 */
for (const theme of ['light', 'dark']) {
  test(`方案与角色 ${theme}：可读对比、长文和试听弹窗`, async ({ page }) => {
    await page.addInitScript(
      (value) => localStorage.setItem('starbridge.theme', value),
      theme,
    )
    const identity = await installFoundationFixture(page, [
      'products.entertainment',
      'studio.projects.read',
      'studio.projects.write',
      'studio.assets.read',
      'studio.assets.write',
      'models.use',
      'files.read',
    ])
    identity.signedIn = true
    const { project, comparison } = studioProposalFixture()
    project.assets[0]!.description =
      '圆润的小鹿，浅棕色毛发，背着蓝色旅行背包。'.repeat(18)
    const base = '/api/studio/projects/' + project.id
    await page.route('**' + base, (route) => route.fulfill({ json: project }))
    await page.route('**' + base + '/preparation', (route) =>
      route.fulfill({ json: { revision: 3, stages: [] } }),
    )
    await page.route('**' + base + '/proposals/proposal', (route) =>
      route.fulfill({ json: comparison }),
    )
    await page.route('**/api/studio/catalog', (route) =>
      route.fulfill({
        json: {
          agents: [],
          defaults: [
            { capability: 'speech.synthesize', configurationId: 'speech' },
          ],
          configurations: [
            {
              id: 'speech',
              name: '合成测试语音',
              capability: 'speech.synthesize',
              modelId: 'fixture',
              connectionId: 'fixture',
              parameters: { voices: '温柔声音,活泼声音' },
            },
          ],
        },
      }),
    )
    const output = resolve(
      process.env.WEB_ADMIN_VALIDATION_DIR ??
        '.superdsh-work/web-admin-validation/lulu-workflow/proposal-layout',
      'screens',
    )
    await mkdir(output, { recursive: true })
    await page.goto('/#/entertainment/' + project.id + '?section=script')
    const review = page.locator('[aria-label="导演方案审阅"]')
    await expect(
      review.getByText('第 1 镜 · 新增', { exact: true }),
    ).toBeVisible()
    await expect(review).not.toContainText(/scriptRange|30000000|sceneId/)
    await expect(review).toContainText('时长：5 秒')
    await expect(review).toContainText('小鹿：一起去看看吧！')
    for (const width of [390, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: 960 })
      await review
        .getByText('第 1 镜 · 新增', { exact: true })
        .scrollIntoViewIfNeeded()
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      ).toBe(true)
      expect(
        await review
          .locator('.proposal-values')
          .evaluateAll((nodes) =>
            nodes.every((node) =>
              [...node.querySelectorAll('p')].every(
                (p) =>
                  !['auto', 'scroll'].includes(getComputedStyle(p).overflowY),
              ),
            ),
          ),
      ).toBe(true)
      await page.screenshot({
        path: resolve(output, `proposal-${theme}-${width}.png`),
        animations: 'disabled',
      })
    }
    await review.getByRole('button', { name: '选择无冲突建议' }).click()
    await expect(
      review.getByRole('checkbox', { name: '剧本正文', exact: true }),
    ).not.toBeChecked()
    await review.getByText('剧本正文', { exact: true }).click()
    await expect(
      review.getByRole('button', { name: '采用选中字段' }),
    ).toBeDisabled()
    await review
      .getByText('确认用此建议覆盖该字段的手工修改', { exact: true })
      .click()
    await expect(
      review.getByRole('button', { name: '采用选中字段' }),
    ).toBeEnabled()
    project.proposal = null
    await page.goto('/#/entertainment/' + project.id + '?section=cast')
    await expect(page.getByRole('button', { name: '试听选音色' })).toBeVisible()
    await page.getByRole('button', { name: '展开设定', exact: true }).click()
    await expect(
      page.getByRole('button', { name: '收起设定', exact: true }),
    ).toHaveAttribute('aria-expanded', 'true')
    await page.getByRole('button', { name: '收起设定', exact: true }).click()
    for (const width of [390, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: 960 })
      await page
        .getByRole('button', { name: '试听选音色' })
        .scrollIntoViewIfNeeded()
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      ).toBe(true)
      await page.screenshot({
        path: resolve(output, `cast-${theme}-${width}.png`),
        animations: 'disabled',
      })
    }
    await page.getByRole('button', { name: '试听选音色' }).click()
    const voice = page.getByRole('dialog', { name: '小鹿 · 试听音色' })
    for (const width of [390, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: 960 })
      await expect(
        voice.getByRole('button', { name: '检查本次方案' }),
      ).toBeInViewport()
      expect(
        await voice.evaluate(
          (node) => node.scrollWidth <= node.clientWidth + 1,
        ),
      ).toBe(true)
      await page.screenshot({
        path: resolve(output, `voice-${theme}-${width}.png`),
        animations: 'disabled',
      })
    }
  })
}
