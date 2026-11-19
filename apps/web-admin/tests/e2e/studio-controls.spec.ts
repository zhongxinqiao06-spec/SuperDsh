import { expect, test, type Page } from '@playwright/test'
import { installParityFixture } from '../parity/ui-fixture'
import { newShot } from '../../fronted/src/utils/studio/storyboard'
import type { StudioProject } from '../../fronted/src/types/studio/studio'
import { expectControlAppearance } from './control-appearance'
import { captureDesign } from './design-capture'

/** 使用本地合成工程检查表单，不读写用户作品、不提交媒体生成。 */
async function installControlsFixture(page: Page, readonly = false) {
  const state = await installParityFixture(page, {
    bothProducts: true,
    ...(readonly
      ? {
          permissions: [
            'products.entertainment',
            'studio.projects.read',
            'studio.assets.read',
          ],
        }
      : {
          permissions: [
            'products.entertainment',
            'studio.projects.read',
            'studio.projects.write',
            'studio.assets.read',
            'studio.assets.write',
            'models.use',
            'sessions.read',
            'sessions.run',
            'files.read',
            'files.write',
          ],
        }),
  })
  const project: StudioProject = {
    id: 'controls-film',
    title: '控件检查作品',
    revision: 1,
    sessionId: null,
    updated: '',
    brief: '雨后的车站，两个人准备出发。',
    aspectWidth: 9,
    aspectHeight: 16,
    targetDurationMs: 60000,
    language: 'zh-CN',
    styleBrief: '自然光',
    assets: [],
    jobs: [],
    history: [],
    proposal: null,
    document: {
      script: '小林走向站台。',
      scenes: [{ id: 'scene', title: '站台', synopsis: '准备出发' }],
      assets: [],
      shots: [
        { ...newShot(), id: 'shot', sceneId: 'scene', action: '走向站台' },
      ],
      music: null,
      musicVolume: 1,
    },
  }
  const writes: string[] = []
  await page.route('**/api/studio/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (route.request().method() !== 'GET') {
      writes.push(path)
      return route.fulfill({
        status: 405,
        json: { detail: '样式检查不提交业务写入' },
      })
    }
    const responses: Record<string, unknown> = {
      '/api/studio/projects/controls-film': project,
      '/api/studio/projects/controls-film/episode-context': null,
      '/api/studio/works': { total: 0, items: [] },
      '/api/studio/projects/controls-film/preparation': {
        revision: 1,
        stages: [],
      },
      '/api/studio/catalog': { configurations: [], defaults: [], agents: [] },
      '/api/studio/creation-defaults': {
        aspectWidth: 9,
        aspectHeight: 16,
        targetDurationMs: 60000,
        language: 'zh-CN',
      },
      '/api/studio/assets': [],
    }
    return path in responses
      ? route.fulfill({ json: responses[path] })
      : route.fallback()
  })
  return { state, writes }
}

for (const theme of ['light', 'dark']) {
  test(`创作控件 ${theme}：八步骤、画幅筛选、原生表单与新建弹窗`, async ({
    page,
  }) => {
    test.setTimeout(180_000)
    await page.addInitScript(
      (value) => localStorage.setItem('starbridge.theme', value),
      theme,
    )
    const { state, writes } = await installControlsFixture(page)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    for (const section of [
      'brief',
      'script',
      'cast',
      'storyboard',
      'sample',
      'production',
      'edit',
      'delivery',
    ]) {
      await page.goto(`/#/entertainment/controls-film?section=${section}`, {
        waitUntil: 'load',
        timeout: 90000,
      })
      await expect(
        page.getByRole('heading', { name: '控件检查作品', exact: true }),
      ).toBeVisible({ timeout: 30000 })
      const editor = page.locator('.studio-editor')
      for (const width of [1440, 1280, 768, 390]) {
        await page.setViewportSize({
          width,
          height: width === 390 ? 844 : 1000,
        })
        if (section === 'storyboard' && width === 390)
          await page
            .getByRole('button', { name: '镜头设定', exact: true })
            .click()
        await expectControlAppearance(editor)
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true)
        if (section === 'brief') {
          const ratio = page.getByRole('combobox', {
            name: '画幅',
            exact: true,
          })
          await expect(
            ratio.locator(
              'xpath=ancestor::div[contains(@class,"el-select__wrapper")]',
            ),
          ).toContainText('竖屏 · 9:16')
          await ratio.fill('横屏')
          await expect(
            page.getByRole('option', { name: '横屏 · 16:9', exact: true }),
          ).toBeVisible()
          await expectControlAppearance(editor)
          // 组件库先清除筛选词，再用 Esc 收起选项；两步均不能改写已选画幅。
          await ratio.press('Escape')
          await expect(ratio).toHaveValue('')
          await ratio.press('Escape')
          await expect(
            page.getByRole('option', { name: '横屏 · 16:9', exact: true }),
          ).toBeHidden()
          // 只筛选，不选择新值；退出后仍显示原画幅且不产生未保存修改。
          await expect(
            page.getByRole('button', { name: '保存制作规格', exact: true }),
          ).toBeDisabled()
        }
        if (width === 1440 || width === 390)
          await captureDesign(
            page,
            `studio-controls-${section}-${theme}-${width}.png`,
          )
      }
      if (section === 'cast') {
        await page
          .getByRole('button', { name: '新建或编辑本片设定', exact: true })
          .first()
          .click()
        const drawer = page.getByRole('dialog', {
          name: '项目素材与个人库',
          exact: true,
        })
        for (const width of [1440, 1280, 768, 390]) {
          await page.setViewportSize({
            width,
            height: width === 390 ? 844 : 1000,
          })
          await expectControlAppearance(drawer)
          await expect(
            drawer.getByRole('combobox', { name: '类型', exact: true }),
          ).toBeVisible()
          await captureDesign(page, `studio-library-${theme}-${width}.png`)
        }
        await drawer.locator('.el-drawer__close-btn').click()
      }
      if (section === 'storyboard') {
        await page
          .getByRole('button', { name: '生成此镜候选', exact: true })
          .click()
        const dialog = page.getByRole('dialog', {
          name: '确认生成任务',
          exact: true,
        })
        await expect(dialog).toBeVisible()
        await expectControlAppearance(dialog)
        await expect(
          dialog.getByRole('button', { name: '检查生成方案', exact: true }),
        ).toBeDisabled()
        await captureDesign(page, `studio-generation-${theme}.png`)
        await dialog.getByRole('button', { name: '取消', exact: true }).click()
      }
    }
    await page.goto('/#/entertainment')
    await page.getByRole('button', { name: '新建作品', exact: true }).click()
    await page.getByRole('menuitem', { name: /分镜创作/ }).click()
    const dialog = page.getByRole('dialog', {
      name: '新建分镜作品',
      exact: true,
    })
    for (const width of [1440, 1280, 768, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await expectControlAppearance(dialog)
      await captureDesign(page, `studio-new-${theme}-${width}.png`)
    }
    const ratio = dialog.getByRole('combobox', { name: '画幅', exact: true })
    await ratio.fill('横屏')
    await page.getByRole('option', { name: '横屏 · 16:9', exact: true }).click()
    await expect(dialog.locator('.el-select__wrapper')).toContainText(
      '横屏 · 16:9',
    )
    await expectControlAppearance(dialog)
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    expect(writes).toEqual([])
    expect(state.missing).toEqual([])
    expect(errors).toEqual([])
  })
}

test('只读创作表单：画幅值可读、数字与原生编辑控件不可修改', async ({
  page,
}) => {
  await installControlsFixture(page, true)
  await page.goto('/#/entertainment/controls-film?section=brief')
  await expect(
    page.getByRole('combobox', { name: '画幅', exact: true }),
  ).toBeDisabled()
  await expect(
    page.getByRole('spinbutton', { name: '目标时长', exact: true }),
  ).toBeDisabled()
  await expectControlAppearance(page.locator('.studio-editor'))
  await page.getByRole('link', { name: '分镜设计', exact: true }).click()
  await expect(page.getByLabel('动作摘要')).toBeDisabled()
  await expectControlAppearance(page.locator('.studio-editor'))
})
