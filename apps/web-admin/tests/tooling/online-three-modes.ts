/** 发布后只读验收；不记录认证材料，不启动制作任务，不改线上业务数据。 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium, expect, type Page } from '@playwright/test'
import type { WorkSummary } from '../../fronted/src/types/studio/works'
import type { QuickModel } from '../../fronted/src/types/studio/quick'

const origin = new URL(
  process.env.WEB_ADMIN_ONLINE_URL ?? 'http://43.142.137.254:5174',
).origin
const password = process.env.WEB_ADMIN_E2E_PASSWORD
if (!password) throw new Error('请通过 WEB_ADMIN_E2E_PASSWORD 提供登录密码')
const release = resolve(
  '.superdsh-work/web-admin-validation/three-modes-release-20261118',
)
const output = resolve(release, 'online-browser')
const identities = JSON.parse(
  await readFile(resolve(release, 'demo-source/identities.json'), 'utf8'),
) as { quickId: string; seriesId: string; episodeIds: string[] }
const previous = JSON.parse(
  await readFile(resolve(release, 'online-before.json'), 'utf8'),
) as { projects: { id: string }[] }
const report = {
  started: new Date().toISOString(),
  origin,
  readOnly: true,
  checks: [] as string[],
  screenshots: [] as string[],
  consoleErrors: [] as string[],
  pageErrors: [] as string[],
  unexpectedWrites: [] as string[],
  failedRequests: [] as string[],
  quickModels: [] as QuickModel[],
  loggedOut: false,
  passed: false,
  failure: '',
}

// 错误仅保存摘要；URL、令牌、请求头和登录响应均不写入证据。
function safeMessage(value: string): string {
  return value
    .replaceAll(password!, '[redacted]')
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/https?:\/\/\S+/giu, '[url]')
    .replace(
      /(?:accessToken|refreshToken|password|token)["'=:\s]+\S+/giu,
      '[redacted]',
    )
    .slice(0, 700)
}

await mkdir(output, { recursive: true })
// 与本地回归配置一致，Windows 复用已安装 Edge，浏览器数据仍完全隔离。
const installedEdge =
  process.platform === 'win32' &&
  ['PROGRAMFILES(X86)', 'PROGRAMFILES', 'LOCALAPPDATA'].some((key) => {
    const directory = process.env[key]
    return (
      directory &&
      existsSync(resolve(directory, 'Microsoft/Edge/Application/msedge.exe'))
    )
  })
const browser = await chromium.launch({
  headless: true,
  channel:
    process.env.WEB_ADMIN_BROWSER_CHANNEL ??
    (installedEdge ? 'msedge' : undefined),
})
const context = await browser.newContext({
  baseURL: origin,
  viewport: { width: 1440, height: 1000 },
  reducedMotion: 'reduce',
  serviceWorkers: 'block',
})
const page = await context.newPage()
page.setDefaultTimeout(30_000)
let signedIn = false
let recording = false
let step = 'login'

// 鉴权与媒体访问票据是只读页面的必要会话操作，其余写请求在发出前拦截。
await context.route('**/api/**', async (route) => {
  const request = route.request()
  const path = new URL(request.url()).pathname
  const method = request.method()
  const allowed =
    ['GET', 'HEAD', 'OPTIONS'].includes(method) ||
    (method === 'POST' &&
      (/^\/api\/auth\/(password-salt|login|refresh|logout)$/u.test(path) ||
        /^\/api\/studio\/.+\/access$/u.test(path)))
  if (allowed) return route.continue()
  report.unexpectedWrites.push(method + ' ' + path)
  await route.abort('blockedbyclient')
})
page.on('pageerror', (error) => {
  if (recording) report.pageErrors.push(safeMessage(error.message))
})
page.on('console', (message) => {
  if (recording && message.type() === 'error')
    report.consoleErrors.push(safeMessage(message.text()))
})
page.on('response', (response) => {
  const path = new URL(response.url()).pathname
  if (recording && path.startsWith('/api/') && response.status() >= 400)
    report.failedRequests.push(response.status() + ' ' + path)
})

async function visit(path: string): Promise<void> {
  await page.goto('/#' + path, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('[data-console-shell]')).toBeVisible()
}

async function capture(
  name: string,
  width: number,
  dark: boolean,
): Promise<void> {
  await page.setViewportSize({ width, height: 1000 })
  await page.evaluate((value) => {
    document.documentElement.classList.toggle('dark', value)
  }, dark)
  await expect
    .poll(() =>
      page.evaluate(() => {
        const main = document.querySelector<HTMLElement>(
          '[data-console-content]',
        )
        return (
          document.documentElement.scrollWidth <= innerWidth + 1 &&
          (!main || main.scrollWidth <= main.clientWidth + 1)
        )
      }),
    )
    .toBeTruthy()
  await expect(page.locator('.el-alert--error')).toHaveCount(0)
  // 先等可见媒体解码首帧，避免把请求刚发出时的空播放器误当作验收截图。
  await expect
    .poll(
      () =>
        page.locator('.studio-media:visible').evaluateAll((hosts) =>
          hosts.every((element) => {
            const box = element.getBoundingClientRect()
            const video = element.querySelector('video')
            const image = element.querySelector('img')
            return (
              box.bottom < 0 ||
              box.top > innerHeight ||
              box.right < 0 ||
              box.left > innerWidth ||
              Boolean(
                video &&
                video.readyState >= 2 &&
                video.videoWidth > 0 &&
                !video.error,
              ) ||
              Boolean(image && image.complete && image.naturalWidth > 0)
            )
          }),
        ),
      { timeout: 45_000 },
    )
    .toBeTruthy()
  const filename = `${name}-${dark ? 'dark' : 'light'}-${width}.png`
  await page.screenshot({ path: resolve(output, filename), fullPage: true })
  if (!report.screenshots.includes(filename)) report.screenshots.push(filename)
}

async function catalog(mode: string, label: string): Promise<WorkSummary[]> {
  const response = page.waitForResponse((value) => {
    const url = new URL(value.url())
    return (
      url.pathname === '/api/studio/works' &&
      url.searchParams.get('mode') === mode &&
      value.request().method() === 'GET'
    )
  })
  await page.getByRole('tab', { name: label, exact: true }).click()
  const result = await response
  expect(result.ok()).toBeTruthy()
  const data = (await result.json()) as { items: WorkSummary[] }
  await expect(page.locator('[aria-label="作品项目"]')).toHaveAttribute(
    'aria-busy',
    'false',
  )
  expect(data.items.every((work) => mode === 'all' || work.kind === mode)).toBe(
    true,
  )
  return data.items
}

async function signOut(target: Page): Promise<void> {
  await target.setViewportSize({ width: 1440, height: 1000 })
  await target.getByRole('button', { name: '退出登录', exact: true }).click()
  const response = target.waitForResponse((value) =>
    new URL(value.url()).pathname.endsWith('/auth/logout'),
  )
  await target
    .getByRole('dialog', { name: '退出登录', exact: true })
    .getByRole('button', { name: '确认退出', exact: true })
    .click()
  expect((await response).ok()).toBeTruthy()
  await expect(target.getByLabel('用户名或邮箱')).toBeVisible()
  report.loggedOut = true
  signedIn = false
}

try {
  await page.goto('/#/login', { waitUntil: 'domcontentloaded' })
  await page
    .getByLabel('用户名或邮箱')
    .fill(process.env.WEB_ADMIN_E2E_USER ?? 'admin')
  await page.getByLabel('密码', { exact: true }).fill(password)
  const login = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith('/auth/login'),
  )
  await page.getByRole('button', { name: '登录 ↵', exact: true }).click()
  expect((await login).ok()).toBeTruthy()
  signedIn = true
  recording = true
  report.checks.push('真实账号登录成功（不记录响应或凭据）')

  for (const { width, dark } of [
    { width: 1440, dark: false },
    { width: 390, dark: true },
  ]) {
    step = `catalog-${width}`
    await visit('/entertainment')
    await expect(
      page.getByRole('heading', { name: '我的作品', exact: true }),
    ).toBeVisible()
    await expect(page.locator('[aria-label="作品项目"]')).toHaveAttribute(
      'aria-busy',
      'false',
    )
    await capture('works-all', width, dark)
    for (const [mode, label] of [
      ['quick', '快速视频'],
      ['storyboard', '分镜作品'],
      ['series', '系列短剧'],
      ['all', '全部'],
    ] as const) {
      const works = await catalog(mode, label)
      if (mode === 'quick')
        expect(works.some((work) => work.id === identities.quickId)).toBe(true)
      if (mode === 'series')
        expect(works.some((work) => work.id === identities.seriesId)).toBe(true)
      await capture('works-' + mode, width, dark)
    }
    report.checks.push(`${width}px：四类作品筛选与横向溢出检查通过`)

    step = `quick-${width}`
    const quickResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith(
        '/' + identities.quickId + '/quick',
      ),
    )
    await visit('/entertainment/quick/' + identities.quickId)
    // 只读取能力公开字段；鉴权头仅在内存转交请求，不写日志或验证产物。
    const detail = await quickResponse
    const authorization = detail.request().headers().authorization
    if (!authorization) throw new Error('快速草稿请求缺少有效会话')
    const capabilities = await page.request.get(
      '/api/studio/quick-capabilities',
      {
        headers: { authorization },
      },
    )
    expect(capabilities.ok()).toBeTruthy()
    const capabilityData = (await capabilities.json()) as {
      models: QuickModel[]
    }
    report.quickModels = capabilityData.models.map(
      ({
        id,
        name,
        inputModes,
        durations,
        aspects,
        resolutions,
        maxReferences,
      }) => ({
        id,
        name,
        inputModes,
        durations,
        aspects,
        resolutions,
        maxReferences,
      }),
    )
    await expect(page.getByLabel('快速作品名称')).not.toHaveValue('')
    await expect(page.locator('.quick-workspace')).toBeVisible()
    await capture('quick-draft', width, dark)
    if (width < 900) {
      await page.locator('.quick-results').scrollIntoViewIfNeeded()
      await capture('quick-results', width, dark)
    }
    report.checks.push(`${width}px：快速示例草稿与候选区只读打开`)

    step = `series-${width}`
    await visit(
      '/entertainment/series/' + identities.seriesId + '?section=overview',
    )
    await expect(page.locator('.series-nav')).toBeVisible()
    await capture('series-overview', width, dark)
    await page.getByRole('link', { name: '故事与分集', exact: true }).click()
    await expect(page.locator('.series-directory-item')).toHaveCount(
      identities.episodeIds.length,
    )
    await expect(page.getByLabel('本集名称', { exact: true })).not.toHaveValue(
      '',
    )
    await capture('series-episodes', width, dark)
    await page.getByLabel('本集名称', { exact: true }).scrollIntoViewIfNeeded()
    await capture('series-story', width, dark)
    report.checks.push(`${width}px：系列总览与两集故事编排只读打开`)

    for (const [index, project] of previous.projects.entries()) {
      step = `legacy-${index + 1}-${width}`
      await visit('/entertainment/' + project.id + '?section=storyboard')
      await expect(page.locator('.studio-shot').first()).toBeVisible()
      const preview = page.locator('video[controls]').first()
      await expect(preview).toBeVisible()
      await preview.evaluate(async (element) => {
        const video = element as HTMLVideoElement
        video.muted = true
        await video.play()
      })
      await expect
        .poll(
          () =>
            preview.evaluate(
              (element) => (element as HTMLVideoElement).currentTime,
            ),
          { timeout: 30_000 },
        )
        .toBeGreaterThan(0.15)
      await preview.evaluate((element) => (element as HTMLVideoElement).pause())
      await capture('legacy-project-' + (index + 1), width, dark)
    }
    report.checks.push(`${width}px：原有小狗与噜噜作品分镜可读`)
  }
  expect(report.unexpectedWrites).toEqual([])
  expect(report.failedRequests).toEqual([])
  expect(report.consoleErrors).toEqual([])
  expect(report.pageErrors).toEqual([])
  step = 'logout'
  recording = false
  await signOut(page)
  report.passed = true
} catch (error) {
  report.failure =
    step +
    ': ' +
    safeMessage(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  recording = false
  if (signedIn) {
    try {
      await signOut(page)
    } catch {
      report.failure += '；退出登录未确认成功，浏览器会话已关闭'
      report.passed = false
      process.exitCode = 1
    }
  }
  await context.close()
  await browser.close()
  await writeFile(
    resolve(output, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
    'utf8',
  )
  console.log(
    JSON.stringify({
      passed: report.passed,
      checks: report.checks.length,
      screenshots: report.screenshots.length,
      report: resolve(output, 'report.json'),
    }),
  )
}
