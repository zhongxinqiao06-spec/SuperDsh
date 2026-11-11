import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { installResourceFixture } from './resource-fixture.ts'
import {
  exerciseResourceScenario,
  resourceScenarios,
} from './resource-actions.ts'

const output = resolve(
  process.env.WEB_ADMIN_UI_OUTPUT ??
    '.superdsh-work/web-admin-validation/phase-three-ui',
)
const selectedTargets = process.env.PARITY_UI_TARGETS?.split(',')
const selectedCases = process.env.PARITY_UI_CASES?.split(',')
const reportFile =
  process.env.PARITY_UI_RESOURCE_REPORT ?? 'ui-resource-flows.json'
await mkdir(resolve(output, 'resource-flows'), { recursive: true })
/** 单浏览器串行运行两个真实前端；合成传输、旧产物来源和业务断言分别记账。 */
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const results: unknown[] = []
try {
  for (const target of ['legacy', 'current'] as const) {
    if (selectedTargets && !selectedTargets.includes(target)) continue
    const origin =
      target === 'legacy'
        ? (process.env.WEB_ADMIN_LEGACY_UI_URL ?? 'http://localhost:5188')
        : (process.env.WEB_ADMIN_CURRENT_UI_URL ?? 'http://localhost:5187')
    for (const scenario of resourceScenarios) {
      if (selectedCases && !selectedCases.includes(scenario)) continue
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        colorScheme: 'light',
        deviceScaleFactor: 1,
      })
      await context.addInitScript(() => {
        localStorage.setItem('theme', 'light')
        localStorage.setItem('starbridge.theme', 'light')
        localStorage.setItem('agents-anywhere.locale', 'zh-CN')
        localStorage.setItem('agents-anywhere.locale.source', 'manual')
      })
      const page = await context.newPage()
      const fixture = await installResourceFixture(
        page,
        scenario === 'file-readonly' ? { permissions: ['files.read'] } : {},
      )
      const errors: string[] = [],
        evidence: unknown[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      let failure = ''
      try {
        await exerciseResourceScenario(
          page,
          scenario,
          fixture,
          origin,
          async (stage) => {
            // 聚焦下方控件会触发浏览器滚动；统一只重置弹窗视口，不修改草稿或掩盖内容。
            await page.getByRole('dialog').evaluateAll((dialogs) => {
              for (const dialog of dialogs) {
                dialog.scrollTop = 0
                for (const element of dialog.querySelectorAll<HTMLElement>('*'))
                  if (
                    element.scrollHeight > element.clientHeight &&
                    ['auto', 'scroll'].includes(
                      getComputedStyle(element).overflowY,
                    )
                  )
                    element.scrollTop = 0
              }
            })
            const screenshot = `resource-flows/${target}-${scenario}-${stage}.png`
            await page.screenshot({
              path: resolve(output, screenshot),
              fullPage: true,
              animations: 'disabled',
            })
            evidence.push({
              stage,
              dialogScroll: 'top',
              screenshot,
              url: page.url(),
              text: await page.locator('body').innerText(),
              buttons: await page.getByRole('button').allTextContents(),
            })
          },
        )
      } catch (error) {
        failure = String(error)
      }
      if (!failure && errors.length)
        failure = `浏览器运行异常：${errors.join('；')}`
      results.push({
        target,
        scenario,
        assertionsPassed: !failure,
        failure,
        pageErrors: errors,
        evidence,
        requests: fixture.operations,
        reads: fixture.reads,
      })
      await writeFile(
        resolve(output, reportFile),
        JSON.stringify(
          {
            evidenceKind: 'actual-browser-synthetic-http',
            legacyProvenance:
              process.env.PARITY_UI_LEGACY_PROVENANCE ??
              'Existing production build reference; current resource/skill source is newer and not browser-verified',
            fullParity: false,
            results,
          },
          null,
          2,
        ),
      )
      process.stdout.write(
        `${target} ${scenario}: ${failure ? 'failed' : 'assertions passed'}\n`,
      )
      await context.close()
    }
  }
} finally {
  await browser.close()
}
if (results.some((result) => Boolean((result as { failure: string }).failure)))
  process.exitCode = 1
