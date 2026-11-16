import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { installFoundationFixture } from './foundation-fixture'
import { studioProposalFixture } from '../fixtures/studio-proposal'

/** 单镜编辑折叠只影响呈现，轨道切镜不能丢失本地裁剪与字幕草稿。 */
test('剪辑页只展开选中镜头，轨道切换保留未保存字段', async ({ page }) => {
  const identity = await installFoundationFixture(page, [
    'products.entertainment',
    'studio.projects.read',
    'studio.projects.write',
    'files.read',
  ])
  identity.signedIn = true
  const { project, shot } = studioProposalFixture()
  project.proposal = null
  project.document.shots = Array.from({ length: 4 }, (_, index) => ({
    ...structuredClone(shot),
    id: 'shot-' + index,
    scene: `海岸场景 ${index + 1}`,
    action: '小鹿沿着海边慢慢散步，望向远处的灯塔。'.repeat(20),
    lines: [{ ...shot.lines[0]!, id: 'line-' + index }],
  }))
  project.history = [
    { revision: 1, label: '初稿' },
    { revision: 2, label: '调整镜头' },
    { revision: 3, label: '当前工程' },
  ]
  const path = '/api/studio/projects/' + project.id
  await page.route('**' + path, (route) => route.fulfill({ json: project }))
  await page.route('**' + path + '/preparation', (route) =>
    route.fulfill({ json: { revision: 3, stages: [] } }),
  )
  await page.goto('/#/entertainment/' + project.id + '?section=edit')
  const panels = page.locator('.timeline-shot-editor')
  await expect(panels).toHaveCount(4)
  await expect(page.locator('.timeline-shot-editor[open]')).toHaveCount(1)
  await expect(panels.first()).toHaveAttribute('open')
  await panels.first().getByLabel('入点（毫秒）', { exact: true }).fill('250')
  await panels.first().getByLabel('字幕', { exact: true }).fill('本地字幕草稿')
  await page.getByRole('button', { name: '镜 3', exact: true }).click()
  await expect(panels.nth(2)).toHaveAttribute('open')
  await expect(panels.first()).not.toHaveAttribute('open')
  await expect(panels.nth(2).locator('summary')).toBeInViewport()
  await page.getByRole('button', { name: '镜 1', exact: true }).click()
  await expect(
    panels.first().getByLabel('入点（毫秒）', { exact: true }),
  ).toHaveValue('250')
  await expect(panels.first().getByLabel('字幕', { exact: true })).toHaveValue(
    '本地字幕草稿',
  )
  await expect(page.locator('.timeline-history')).not.toHaveAttribute('open')
  await expect(page.locator('.timeline-monitor h3')).toContainText('海岸场景 1')
  await expect(page.locator('.timeline-monitor h3')).not.toContainText('散步')
  const output = resolve(
    process.env.WEB_ADMIN_VALIDATION_DIR ??
      '.superdsh-work/web-admin-validation/lulu-workflow/timeline-layout',
    'screens',
  )
  await mkdir(output, { recursive: true })
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 960 })
    await panels.first().locator('summary').scrollIntoViewIfNeeded()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true)
    await page.screenshot({
      path: resolve(output, `timeline-${width}.png`),
      animations: 'disabled',
    })
  }
})
