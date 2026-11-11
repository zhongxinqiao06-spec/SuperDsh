import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { consoleModules } from '../../fronted/src/utils/console/modules.ts'
import { installParityFixture } from './ui-fixture.ts'

/** 逐端、逐页采集真实应用截图与可访问动作，单页串行以适配开发机器内存。 */
const output = resolve(
  process.env.WEB_ADMIN_UI_OUTPUT ??
    '.superdsh-work/web-admin-validation/phase-three-ui',
)
await mkdir(resolve(output, 'screenshots'), { recursive: true })
const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--disable-background-networking'],
})
const report: unknown[] = []
const selectedModules = process.env.PARITY_UI_MODULES?.split(',')
const selectedVariants = process.env.PARITY_UI_VARIANTS?.split(',')
const selectedTargets = process.env.PARITY_UI_TARGETS?.split(',')
const variants = [
  { id: 'light-desktop', theme: 'light', width: 1440, height: 1000 },
  { id: 'dark-desktop', theme: 'dark', width: 1440, height: 1000 },
  { id: 'light-mobile', theme: 'light', width: 390, height: 844 },
  { id: 'dark-mobile', theme: 'dark', width: 390, height: 844 },
  {
    id: 'loading-desktop',
    theme: 'light',
    width: 1440,
    height: 1000,
    state: 'loading',
  },
  {
    id: 'error-desktop',
    theme: 'light',
    width: 1440,
    height: 1000,
    state: 'error',
  },
  {
    id: 'denied-desktop',
    theme: 'light',
    width: 1440,
    height: 1000,
    denied: true,
  },
] as const
try {
  for (const variant of variants) {
    if (selectedVariants && !selectedVariants.includes(variant.id)) continue
    for (const target of ['legacy', 'current'] as const) {
      if (selectedTargets && !selectedTargets.includes(target)) continue
      const origin =
        target === 'legacy'
          ? (process.env.WEB_ADMIN_LEGACY_UI_URL ?? 'http://localhost:5188')
          : (process.env.WEB_ADMIN_CURRENT_UI_URL ?? 'http://localhost:5187')
      const context = await browser.newContext({
        locale: 'zh-CN',
        viewport: { width: variant.width, height: variant.height },
        deviceScaleFactor: 1,
        colorScheme: variant.theme,
        timezoneId: 'Asia/Shanghai',
      })
      await context.addInitScript((theme) => {
        localStorage.setItem('theme', theme)
        localStorage.setItem('starbridge.theme', theme)
        localStorage.setItem('agents-anywhere.locale', 'zh-CN')
        localStorage.setItem('agents-anywhere.locale.source', 'manual')
      }, variant.theme)
      const page = await context.newPage()
      const fixture = await installParityFixture(page, {
        ...('state' in variant ? { state: variant.state } : {}),
        ...('denied' in variant ? { permissions: [] } : {}),
      })
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      for (const module of consoleModules) {
        if (selectedModules && !selectedModules.includes(module.id)) continue
        const start = errors.length
        const missingStart = fixture.missing.length
        await page.goto(`${origin}/?capture=${module.id}#${module.path}`, {
          waitUntil: 'domcontentloaded',
          timeout: 180000,
        })
        if (variant.id === 'loading-desktop') await page.waitForTimeout(600)
        else await page.waitForLoadState('networkidle')
        await page.waitForTimeout(250)
        await page.evaluate(() => document.fonts.ready)
        await page.screenshot({
          path: resolve(
            output,
            'screenshots',
            `${target}-${module.id}-${variant.id}.png`,
          ),
          fullPage: true,
          animations: 'disabled',
        })
        const evidence = {
          target,
          variant: variant.id,
          module: module.id,
          route: module.path,
          actualUrl: page.url(),
          title: await page.title(),
          text: (await page.locator('body').innerText()).slice(0, 18000),
          actions: await page.getByRole('button').allTextContents(),
          errors: errors.slice(start),
          missing: [...new Set(fixture.missing.slice(missingStart))],
          landmarks: await page
            .locator('h1, h2, main, .page, .management-pagination')
            .evaluateAll((nodes) =>
              nodes.map((node) => ({
                tag: node.tagName,
                text: node.textContent?.slice(0, 80),
                x: node.getBoundingClientRect().x,
                y: node.getBoundingClientRect().y,
                width: node.getBoundingClientRect().width,
                height: node.getBoundingClientRect().height,
              })),
            ),
        }
        report.push(evidence)
        await writeFile(
          resolve(output, process.env.PARITY_UI_REPORT ?? 'ui-capture.json'),
          JSON.stringify(report, null, 2),
        )
        process.stdout.write(
          `${variant.id} ${target} ${module.id}: ${evidence.errors.length} errors, ${evidence.missing.length} missing fixtures\n`,
        )
      }
      await context.close()
    }
  }
} finally {
  await browser.close()
}
