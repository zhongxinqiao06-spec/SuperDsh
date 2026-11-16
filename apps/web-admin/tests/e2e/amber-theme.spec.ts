import { expect, test, type Locator } from '@playwright/test'
import { installParityFixture } from '../parity/ui-fixture'
import { captureDesign } from './design-capture'
import type { StudioProject } from '../../fronted/src/types/studio/studio'

/** 检查实际渐变的全部插值位置，避免仅测兜底色而漏掉白字最浅端。 */
async function expectReadableGradient(target: Locator) {
  const result = await target.evaluate((node) => {
    const style = getComputedStyle(node)
    const stops = [...style.backgroundImage.matchAll(/rgb\(([^)]+)\)/gu)].map(
      (match) => match[1]!.split(',').map(Number),
    )
    const foreground = style.color.match(/[\d.]+/gu)!.map(Number)
    const luminance = (rgb: number[]) => {
      const channels = rgb.slice(0, 3).map((value) => {
        const c = value / 255
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      })
      return (
        channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
      )
    }
    const text = luminance(foreground)
    const contrast =
      stops.length === 2
        ? Array.from({ length: 101 }, (_, index) => {
            const bg = luminance(
              stops[0]!.map(
                (value, channel) =>
                  value + ((stops[1]![channel]! - value) * index) / 100,
              ),
            )
            return (Math.max(bg, text) + 0.05) / (Math.min(bg, text) + 0.05)
          })
        : [0]
    return { minimum: Math.min(...contrast), color: style.color }
  })
  expect(result.minimum).toBeGreaterThanOrEqual(4.5)
  return result.color
}

for (const theme of ['light', 'dark']) {
  test(`琥珀工作台 ${theme}：渐变可读、选段与浮层、窄屏`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(
      (value) => localStorage.setItem('starbridge.theme', value),
      theme,
    )
    await installParityFixture(page, {
      bothProducts: true,
      permissions: [
        'products.entertainment',
        'studio.projects.read',
        'studio.projects.write',
        'studio.assets.read',
        'sessions.read',
        'sessions.run',
      ],
    })
    const script =
      '雨后的站台\n\n傍晚，一场雨刚停。站台的灯依次亮起，积水映着暖黄色的光。\n\n广播响起：末班车即将进站。\n\n一张旧车票留在长椅上，远处传来列车的声音。\n\n小林停下脚步，望向站台尽头。\n小禾说：“这一次，我们一起出发吧。”'
    const project: StudioProject = {
      id: 'amber-film',
      title: '雨后站台',
      brief: '雨后重逢的两个人，决定一起出发。',
      revision: 1,
      sessionId: null,
      updated: '',
      assets: [],
      jobs: [],
      history: [],
      proposal: null,
      aspectWidth: 16,
      aspectHeight: 9,
      targetDurationMs: 60000,
      document: {
        adaptationMode: 'original',
        script,
        scenes: [
          {
            id: 'station',
            title: '雨后站台',
            synopsis: '雨停后的站台，灯光亮起，环境潮湿而安静。',
            scriptRange: { start: 0, end: 10 },
          },
          {
            id: 'ticket',
            title: '长椅上的车票',
            synopsis: '一张旧车票留在长椅上。',
          },
          { id: 'train', title: '末班车进站', synopsis: '两人一同踏上列车。' },
        ],
        assets: [],
        shots: [],
        music: null,
        musicVolume: 1,
      },
    }
    const writes: string[] = []
    await page.route('**/api/studio/**', (route) => {
      const path = new URL(route.request().url()).pathname
      if (route.request().method() !== 'GET') {
        writes.push(path)
        return route.fulfill({
          status: 405,
          json: { detail: '仅检查样式，不提交工程' },
        })
      }
      const responses: Record<string, unknown> = {
        '/api/studio/projects/amber-film': project,
        '/api/studio/projects/amber-film/preparation': {
          revision: 1,
          stages: [],
        },
        '/api/studio/projects/amber-film/text-edits': [],
        '/api/studio/catalog': { configurations: [], defaults: [], agents: [] },
      }
      return path in responses
        ? route.fulfill({ json: responses[path] })
        : route.fallback()
    })
    await page.setViewportSize({ width: 1448, height: 824 })
    await page.goto('/#/entertainment/amber-film?section=script')
    const primary = page.getByRole('button', {
      name: '整理场次与分镜',
      exact: true,
    })
    await expect(primary).toBeEnabled()
    expect(await expectReadableGradient(primary)).toBe('rgb(255, 255, 255)')
    await primary.hover()
    expect(await expectReadableGradient(primary)).toBe('rgb(255, 255, 255)')
    await expectReadableGradient(
      page.locator('.preparation-steps [aria-current="page"]'),
    )
    await expectReadableGradient(
      page.locator('.script-scene-list [aria-current="true"]'),
    )
    await page.mouse.move(0, 0)
    await captureDesign(page, `amber-script-${theme}-1448.png`)
    await page.getByLabel('剧本正文').press('ControlOrMeta+A')
    await captureDesign(page, `amber-selection-${theme}-1448.png`)
    await page.getByRole('button', { name: 'AI 修改选段', exact: true }).click()
    const drawer = page.getByRole('dialog', { name: 'AI 剧本编辑' })
    await expect(drawer).toBeVisible()
    const generate = drawer.getByRole('button', { name: '生成修改建议' })
    await expect(generate).toBeDisabled()
    await expect(generate).toHaveCSS('color', 'rgb(255, 255, 255)')
    await captureDesign(page, `amber-drawer-${theme}-1448.png`)
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
    await page.setViewportSize({ width: 390, height: 844 })
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true)
    await captureDesign(page, `amber-script-${theme}-390.png`)
    await expect(page.getByLabel('剧本正文')).toHaveValue(script)
    expect(writes).toEqual([])
    expect(errors).toEqual([])
  })
}
