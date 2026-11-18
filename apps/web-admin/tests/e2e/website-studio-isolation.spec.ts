import { test, expect } from '@playwright/test'
import { installFoundationFixture } from './foundation-fixture'
import type { StudioProject } from '../../fronted/src/types/studio/studio'

/** 必须经官网路由进入作品，覆盖 SPA 保留官网 CSS 后的真实抽屉布局。 */
for (const theme of ['light', 'dark']) {
  test(`官网进入作品后导演助手不受展示样式影响：${theme}`, async ({
    page,
  }, info) => {
    await page.addInitScript(
      (value) => localStorage.setItem('starbridge.theme', value),
      theme,
    )
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const identity = await installFoundationFixture(page, [
      'products.entertainment',
      'studio.projects.read',
      'studio.projects.write',
      'studio.assets.read',
      'studio.assets.write',
      'files.read',
      'files.write',
      'sessions.read',
      'sessions.run',
    ])
    identity.signedIn = true
    const project: StudioProject = {
      id: 'style-isolation',
      title: '样式隔离回归作品',
      revision: 1,
      sessionId: null,
      updated: '2026-11-18T00:00:00Z',
      assets: [],
      jobs: [],
      history: [],
      proposal: null,
      document: {
        script: '雨停了，她在车站等待下一班车。',
        shots: [],
        assets: [],
        music: null,
        musicVolume: 1,
      },
    }
    const writes: string[] = []
    await page.route(
      (url) => url.pathname.startsWith('/api/studio/'),
      (route) => {
        const path = new URL(route.request().url()).pathname
        if (route.request().method() !== 'GET') writes.push(path)
        if (path.endsWith('/preparation'))
          return route.fulfill({ json: { revision: 1, stages: [] } })
        if (path.endsWith('/director-context'))
          return route.fulfill({
            json: {
              vision: { available: false },
              research: { available: false },
            },
          })
        if (path.endsWith('/catalog'))
          return route.fulfill({
            json: { configurations: [], defaults: [], agents: [] },
          })
        if (path.endsWith('/projects'))
          return route.fulfill({
            json: {
              items: [{ ...project, shots: 0, adopted: 0 }],
              total: 1,
              page: 1,
              pageSize: 10,
            },
          })
        return route.fulfill({ json: project })
      },
    )
    await page.goto('/#/')
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      '让想象',
    )
    await page.getByRole('link', { name: '进入创作台', exact: true }).click()
    await page.getByRole('link', { name: project.title, exact: true }).click()
    await page.getByRole('button', { name: '导演助手', exact: true }).click()
    const panel = page.getByRole('dialog', { name: '作品导演助手' })
    const prompt = panel.getByLabel('给导演的指令', { exact: true })
    for (const width of [390, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: 844 })
      await expect(panel).toBeVisible()
      const content = await panel.locator('.studio-director').boundingBox()
      const field = await prompt.boundingBox()
      expect(field!.width).toBeGreaterThan(content!.width * 0.85)
      expect(
        await panel
          .locator('.studio-director')
          .evaluate((node) => getComputedStyle(node).backgroundColor),
      ).toBe('rgba(0, 0, 0, 0)')
      for (const label of ['上传形象图片', '从素材库选择']) {
        const button = panel.getByRole('button', { name: label, exact: true })
        const bounds = await button.boundingBox()
        expect(bounds!.width).toBeGreaterThan(100)
        expect(bounds!.height).toBeLessThan(80)
      }
      await prompt.fill('保留角色造型，调整第三镜的光线。')
      await expect(
        panel.getByRole('button', { name: '发送', exact: true }),
      ).toBeEnabled()
      await expect(
        panel.getByRole('button', { name: '发送', exact: true }),
      ).toBeInViewport()
      expect(
        await panel.evaluate((node) => node.scrollWidth <= node.clientWidth),
      ).toBe(true)
      await page.screenshot({
        path: info.outputPath(`director-${theme}-${width}.png`),
        animations: 'disabled',
      })
    }
    await panel.locator('.el-drawer__close-btn').click()
    await page.getByRole('button', { name: '导演助手', exact: true }).click()
    await expect(prompt).toHaveValue('保留角色造型，调整第三镜的光线。')
    expect(writes).toEqual([])
  })
}
