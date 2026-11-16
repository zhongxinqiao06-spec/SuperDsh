import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { installParityFixture } from '../parity/ui-fixture'
import { captureDesign } from './design-capture'

async function installOfficeFixture(page: Page) {
  await installParityFixture(page)
  const item = {
    id: 'delivery',
    sessionId: 'parity-session',
    sessionTitle: '经营分析',
    name: '经审核的简报.png',
    mediaType: 'image/png',
    sha256: 'a'.repeat(64),
    createdAt: '2026-10-20T08:00:00Z',
    deliverable: true,
  }
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X9ZkAAAAASUVORK5CYII='
  await page.route('**/api/office/recent-deliverables?*', (route) =>
    route.fulfill({ json: { items: [item] } }),
  )
  await page.route(/\/api\/sessions\?/, (route) => {
    expect(new URL(route.request().url()).searchParams.get('product')).toBe(
      'office',
    )
    return route.fulfill({
      json: {
        sessions: [
          {
            id: item.sessionId,
            title: item.sessionTitle,
            status: 'idle',
            lastActivityAt: item.createdAt,
          },
        ],
        nextCursor: null,
      },
    })
  })
  await page.route('**/agent-artifacts/delivery/preview', (route) =>
    route.fulfill({
      json: {
        name: item.name,
        mediaType: 'image/png',
        contentBase64: png,
        missingFonts: [],
      },
    }),
  )
  await page.route('**/agent-artifacts/delivery/download', (route) =>
    route.fulfill({
      body: Buffer.from(png, 'base64'),
      contentType: 'image/png',
    }),
  )
  await page.route('**/api/sessions/parity-session/agent-artifacts', (route) =>
    route.fulfill({ json: { items: [item] } }),
  )
  const source = {
    id: 'evidence-sales',
    sourceId: 'sheet-A',
    filename: '销售明细.csv',
    content: '月份,收入\n7月,386000',
    sha256: 'f'.repeat(64),
    location: {},
  }
  await page.route('**/api/sessions/parity-session/evidence', (route) =>
    route.fulfill({
      json: {
        items: [source],
        answerVerification: {
          status: 'valid',
          message: '引用已核对',
          issues: [],
        },
      },
    }),
  )
  await page.route(
    '**/api/sessions/parity-session/evidence/evidence-sales',
    (route) => route.fulfill({ json: { source } }),
  )
  return item
}

/** 首页与会话共享同一次发送，成果的预览/下载必须请求各自真实的会话级接口。 */
test('办公首页读取本人近期记录，预览交付、下载并一次发送进入会话', async ({
  page,
}) => {
  const requests: string[] = []
  page.on('request', (request) =>
    requests.push(request.method() + ' ' + new URL(request.url()).pathname),
  )
  const item = await installOfficeFixture(page)
  await page.goto('/#/office')
  await expect(page.getByRole('heading', { name: '最近会话' })).toBeVisible()
  await expect(page.getByRole('link', { name: /经营分析/ })).toBeVisible()
  await page.getByRole('button', { name: '预览 ' + item.name }).click()
  const dialog = page.getByRole('dialog', { name: item.name })
  await expect(dialog.getByRole('img', { name: item.name })).toBeVisible()
  await page.keyboard.press('Escape')
  const downloaded = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载 ' + item.name }).click()
  expect((await downloaded).suggestedFilename()).toBe(item.name)
  expect(
    requests.filter(
      (path) =>
        path === 'POST /api/server-agent' ||
        path === 'POST /api/sessions/create-and-start',
    ),
  ).toEqual([])
  const sent: Record<string, unknown>[] = []
  await page.route('**/api/sessions/create-and-start', async (route) => {
    sent.push(route.request().postDataJSON())
    return route.fulfill({ json: { session: { id: 'parity-session' } } })
  })
  await page.getByRole('textbox', { name: '任务草稿' }).fill('生成本周简报')
  await page
    .getByRole('button', { name: '发送', exact: true })
    .evaluate((button: HTMLButtonElement) => {
      button.click()
      button.click()
    })
  await expect(page).toHaveURL(/#\/workspace\/session\/parity-session$/)
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({
    text: '生成本周简报',
    connectorId: 'parity-device',
    projectId: 'parity-project',
    clientMessageId: expect.any(String),
  })
  await expect(page.getByRole('button', { name: '成果预览' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '任务草稿' })).toHaveValue('')
})

test('办公首页无文件与执行授权时不请求成果和引擎', async ({ page }) => {
  await installParityFixture(page, { permissions: ['sessions.read'] })
  const paths: string[] = []
  page.on('request', (r) => paths.push(new URL(r.url()).pathname))
  await page.goto('/#/office')
  await expect(page.getByRole('heading', { name: '最近会话' })).toBeVisible()
  await expect(page.getByText('暂无办公会话')).toBeVisible()
  await expect(
    page.getByRole('button', { name: '发送', exact: true }),
  ).toHaveCount(0)
  expect(paths).not.toContain('/api/office/recent-deliverables')
  expect(paths).not.toContain('/api/server-agent')
})

for (const width of [390, 768, 1280, 1440]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`办公首页与会话成果适配 ${width}px ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 920 })
      await page.addInitScript(
        (mode) => localStorage.setItem('starbridge.theme', mode),
        theme,
      )
      const item = await installOfficeFixture(page)
      await page.goto('/#/office')
      const root = page.locator('html')
      await expect(root).toHaveAttribute('data-console-product', 'office')
      await expect
        .poll(() => root.evaluate((el) => el.classList.contains('dark')))
        .toBe(theme === 'dark')
      const input = page.getByRole('textbox', { name: '任务草稿' })
      await expect(input).toBeVisible()
      await expect(
        page.getByRole('button', { name: '预览 ' + item.name }),
      ).toBeVisible()
      const recent = page.getByRole('link', { name: /经营分析/ })
      await expect(recent).toBeVisible()
      const noOverflow = () =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
      expect(await noOverflow()).toBe(true)
      const capture = async (view: string) => {
        if (
          ![390, 1440].includes(width) ||
          !process.env.WEB_ADMIN_VALIDATION_DIR
        )
          return
        const dir = resolve(
          process.env.WEB_ADMIN_VALIDATION_DIR,
          'office-screens',
        )
        await mkdir(dir, { recursive: true })
        await page.screenshot({
          path: resolve(dir, `${view}-${width}-${theme}.png`),
          animations: 'disabled',
        })
      }
      await capture('home')
      await captureDesign(page, `office-home-${width}-${theme}.png`)
      await recent.click()
      const results = page.getByRole('complementary', { name: '会话成果' })
      const trigger = page.getByRole('button', { name: '成果预览' })
      await expect(trigger).toBeVisible()
      if (width <= 768) {
        await expect(trigger).toHaveAttribute('aria-expanded', 'false')
        await trigger.click()
      }
      await expect(results).toBeVisible()
      await results.getByRole('button', { name: '预览', exact: true }).click()
      await expect(results.getByRole('img', { name: item.name })).toBeVisible()
      expect(await noOverflow()).toBe(true)
      await capture('session-preview')
      await results.getByText('资料依据与引用校验').click()
      await results
        .getByRole('button', { name: '销售明细.csv · sheet-A' })
        .click()
      const source = page.getByRole('dialog', { name: '销售明细.csv' })
      await expect(source).toContainText('7月,386000')
      await page.keyboard.press('Escape')
      await results.getByRole('button', { name: '收起成果' }).click()
      await expect(results).toBeHidden()
      await expect(input).toBeVisible()
    })
  }
}
test('服务端尚未启动时首页只查询，主动发送准备一次并续交原草稿', async ({
  page,
}) => {
  await installOfficeFixture(page)
  let starts = 0
  let readsAfterStart = 0
  let created = 0
  await page.route('**/api/server-agent', (route) => {
    const posted = route.request().method() === 'POST'
    if (posted) starts++
    else if (starts) readsAfterStart++
    const ready = starts > 0 && readsAfterStart >= 2
    return route.fulfill({
      json: {
        agent: {
          status: ready ? 'running' : starts ? 'starting' : 'stopped',
          connectorId: ready ? 'parity-device' : null,
          projectId: ready ? 'parity-project' : null,
          runtimeId: 'dsh',
          error: null,
        },
      },
    })
  })
  await page.route('**/api/sessions/create-and-start', (route) => {
    created++
    expect(route.request().postDataJSON()).toMatchObject({
      text: '首次冷启动',
      projectId: 'parity-project',
    })
    return route.fulfill({ json: { session: { id: 'parity-session' } } })
  })
  await page.goto('/#/office')
  const draft = page.getByRole('textbox', { name: '任务草稿' })
  await draft.fill('首次冷启动')
  expect(starts).toBe(0)
  const send = page.getByRole('button', { name: '发送', exact: true })
  await send.evaluate((button: HTMLButtonElement) => {
    button.click()
    button.click()
  })
  await expect(page).toHaveURL(/#\/workspace\/session\/parity-session$/)
  expect(starts).toBe(1)
  expect(created).toBe(1)
})
