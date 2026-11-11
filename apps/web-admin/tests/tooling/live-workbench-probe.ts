import { chromium, expect, type Page } from '@playwright/test'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

/** 用户授权的真实默认聊天验收；仅临时账号，凭据只驻留内存，不自动重发模型请求。 */
type Fields = Record<string, unknown>
const root = process.cwd()
const output = resolve(
  root,
  '.superdsh-work/web-admin-validation/default-chat-flow',
)
const settings = JSON.parse(
  await readFile(
    resolve(root, '.superdsh-work/web-admin-dev/config/settings.json'),
    'utf8',
  ),
) as {
  ports: { backendPort: number; frontedPort: number }
  initialAdmin: { username: string; password: string }
}
const origin = `http://localhost:${settings.ports.frontedPort}`
const base = `http://127.0.0.1:${settings.ports.backendPort}/api`
const username = `model_probe_${randomUUID().replaceAll('-', '').slice(0, 12)}`
const password = randomBytes(24).toString('base64url')
let adminToken = '',
  memberToken = '',
  userId = ''
const results: Fields[] = [],
  cleanup: Fields = {}
const evidence: Fields = { username, passed: false, results, cleanup }
await mkdir(output, { recursive: true })

async function request(
  token: string,
  path: string,
  method = 'GET',
  body?: Fields,
): Promise<Fields> {
  const response = await fetch(base + path, {
    method,
    headers: {
      Origin: origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(45000),
  })
  if (!response.ok)
    throw new Error(`${method} ${path}: HTTP ${response.status}`)
  return response.status === 204 ? {} : ((await response.json()) as Fields)
}
async function login(name: string, secret: string): Promise<Fields> {
  return request('', '/auth/login', 'POST', {
    identifier: name,
    password: secret,
    clientName: '默认聊天浏览器验收',
  })
}
async function completed(id: string, after = 0): Promise<Fields> {
  let snapshot: Fields = {}
  await expect
    .poll(
      async () => {
        snapshot = await request(memberToken, `/sessions/${id}/snapshot`)
        const session = snapshot.session as Fields
        return (
          Number(session.latestTurnEndSeq) > after && session.status === 'idle'
        )
      },
      { timeout: 120000, intervals: [1000] },
    )
    .toBe(true)
  const native = await request(memberToken, `/runtime/sessions/${id}`)
  const session = snapshot.session as Fields
  expect(session.agentDefinition).toBeNull()
  const timeline = (snapshot.timeline as { items: Fields[] }).items
  const replies = timeline.filter(
    (item) => item.role === 'assistant' && item.type === 'message',
  )
  expect((replies.at(-1)?.content as Fields).text).toBe('OK')
  return {
    id,
    sequence: session.latestTurnEndSeq,
    replies: replies.length,
    metadata: native.metadata,
    state: snapshot.state,
  }
}
async function style(page: Page): Promise<Fields> {
  return page.locator('.composer').evaluate((element) => {
    const textarea = element.querySelector('textarea')!
    const css = getComputedStyle(textarea),
      box = element.getBoundingClientRect()
    const controls = [
      ...element.querySelectorAll('.composer-options .el-select'),
    ].map((control) => {
      const rect = control.getBoundingClientRect()
      return { x: rect.x, y: rect.y, right: rect.right, width: rect.width }
    })
    return {
      textareaBorder: css.borderWidth,
      textareaRadius: css.borderRadius,
      textareaFont: css.fontSize,
      textareaShadow: css.boxShadow,
      controls,
      fits: controls.every(
        (control) => control.x >= box.x && control.right <= box.right,
      ),
      pageFits: document.documentElement.scrollWidth <= innerWidth,
    }
  })
}
async function verifyComposer(page: Page): Promise<Fields> {
  const appearance = await style(page)
  expect(appearance).toMatchObject({
    textareaBorder: '0px',
    textareaFont: '16px',
    textareaShadow: 'none',
    fits: true,
    pageFits: true,
  })
  const actionsFit = await page.locator('.composer-actions').evaluate((bar) => {
    const bounds = bar.getBoundingClientRect()
    return [
      ...bar.querySelectorAll('.el-select, button, .el-switch, .upload-label'),
    ]
      .filter((element) => element.getBoundingClientRect().width > 0)
      .every((element) => {
        const rect = element.getBoundingClientRect()
        return rect.left >= bounds.left && rect.right <= bounds.right + 1
      })
  })
  expect(actionsFit).toBe(true)
  return appearance
}
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: 'reduce',
})
const page = await context.newPage()
page.setDefaultTimeout(15000)
const sent: Fields[] = [],
  errors: string[] = []
page.on('pageerror', (error) => errors.push(error.message))
page.on('request', (req) => {
  if (new URL(req.url()).pathname === '/api/sessions/create-and-start')
    sent.push(req.postDataJSON() as Fields)
})
try {
  // 开发热重载可能短暂关闭监听；只等待健康读取，绝不重试创建或模型提交。
  await expect
    .poll(
      async () => {
        try {
          return (
            await fetch(`${base}/health/ready`, {
              signal: AbortSignal.timeout(3000),
            })
          ).status
        } catch {
          return 0
        }
      },
      { timeout: 45000, intervals: [1000] },
    )
    .toBe(200)
  adminToken = String(
    (
      await login(
        settings.initialAdmin.username,
        settings.initialAdmin.password,
      )
    ).accessToken,
  )
  userId = String(
    (
      await request(adminToken, '/admin/users', 'POST', {
        username,
        password,
        roles: ['member'],
        displayName: '默认聊天临时验证',
      })
    ).userId,
  )
  evidence.userId = userId
  await writeFile(
    resolve(output, 'evidence.json'),
    JSON.stringify(evidence, null, 2),
  )
  const first = await login(username, password)
  memberToken = String(first.accessToken)
  if (first.resetRequired) {
    await request(memberToken, '/auth/change-password', 'POST', {
      newPassword: password,
    })
    memberToken = String((await login(username, password)).accessToken)
  }
  await page.goto(`${origin}/#/login`)
  await page.getByLabel('用户名或邮箱').fill(username)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录 ↵', exact: true }).click()
  await expect(page.locator('[data-console-shell]')).toBeVisible()
  await page.goto(`${origin}/#/workspace`)
  await expect(
    page.getByRole('status', { name: '服务端 Agent：已就绪' }),
  ).toBeVisible({ timeout: 100000 })
  await expect(page.locator('.composer-options')).toContainText('默认模型：')
  await expect(page.locator('.composer-options')).toContainText('默认权限：')
  evidence.newStyle = await verifyComposer(page)
  await page.screenshot({
    path: resolve(output, 'new-defaults.png'),
    animations: 'disabled',
  })
  for (const number of [1, 2]) {
    if (number === 2)
      await page.getByRole('button', { name: '新会话', exact: true }).click()
    await page
      .getByLabel('任务草稿')
      .fill(`默认流程验证${number}：只回复 OK，不调用工具。`)
    const response = page.waitForResponse(
      (res) => new URL(res.url()).pathname === '/api/sessions/create-and-start',
    )
    await page.getByRole('button', { name: '发送', exact: true }).click()
    const created = await response
    expect(created.status()).toBe(200)
    const id = String(
      ((await created.json()) as { session: Fields }).session.id,
    )
    await expect(page).toHaveURL(new RegExp(id))
    results.push(await completed(id))
    console.log(`Default chat ${number} completed`)
  }
  expect(sent).toHaveLength(2)
  for (const request of sent) {
    expect(request.selections).toEqual({})
    expect(request).not.toHaveProperty('agentDefinitionId')
  }
  const firstId = String(results[0]!.id)
  // 引擎会自动改标题；这个临时账号只有两条会话，点击唯一的非当前历史行。
  const previous = page.locator('.sidebar-session:not(.selected) .session-main')
  await expect(previous).toHaveCount(1)
  await previous.click()
  await expect(page).toHaveURL(new RegExp(firstId))
  await expect(page.locator('.timeline-list')).toContainText('OK')
  await expect(
    page.getByRole('button', { name: '中断任务', exact: true }),
  ).toHaveCount(0)
  await expect(page.locator('.composer')).toContainText('通用对话')
  evidence.historyStyle = await verifyComposer(page)
  await page.screenshot({
    path: resolve(output, 'history-desktop.png'),
    animations: 'disabled',
  })
  await page.locator('.composer .el-switch').click()
  await page
    .getByRole('dialog', { name: '取消接管', exact: true })
    .getByRole('button', { name: '确认', exact: true })
    .click()
  await expect(page.getByLabel('任务草稿')).toBeDisabled()
  evidence.readOnlyStyle = await verifyComposer(page)
  await page.screenshot({
    path: resolve(output, 'history-readonly.png'),
    animations: 'disabled',
  })
  await page.locator('.composer .el-switch').click()
  await page
    .getByRole('dialog', { name: '接管会话', exact: true })
    .getByRole('button', { name: '确认', exact: true })
    .click()
  await expect(page.getByLabel('任务草稿')).toBeEnabled()
  await page.setViewportSize({ width: 1204, height: 1000 })
  await page
    .getByLabel('任务草稿')
    .fill('继续默认流程验证：仍只回复 OK，不调用工具。')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(
    page.getByRole('button', { name: '中断任务', exact: true }),
  ).toBeVisible()
  evidence.runningStyle = await verifyComposer(page)
  await page.screenshot({
    path: resolve(output, 'history-running.png'),
    animations: 'disabled',
  })
  results.push(await completed(firstId, Number(results[0]!.sequence)))
  expect(results[2]!.metadata).toMatchObject({
    agentPreset: (results[0]!.metadata as Fields).agentPreset,
    modelSelection: (results[0]!.metadata as Fields).modelSelection,
    permissionPreset: (results[0]!.metadata as Fields).permissionPreset,
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '切换会话侧栏', exact: true }).click()
  evidence.mobileStyle = await verifyComposer(page)
  await page.screenshot({
    path: resolve(output, 'history-mobile.png'),
    animations: 'disabled',
  })
  expect(errors).toEqual([])
  evidence.passed = true
} catch (error) {
  evidence.error = String(error).slice(0, 1200)
  await page
    .screenshot({
      path: resolve(output, 'failure.png'),
      animations: 'disabled',
    })
    .catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
  if (userId) {
    try {
      await request(memberToken, '/server-agent', 'DELETE')
      cleanup.runtimeStopped = true
    } catch {
      cleanup.runtimeStopped = false
    }
    try {
      await request(adminToken, `/admin/users/${userId}`, 'DELETE')
      cleanup.userDisabled = true
    } catch {
      cleanup.userDisabled = false
    }
  }
  for (const token of [memberToken, adminToken].filter(Boolean))
    await request(token, '/auth/logout', 'POST', {}).catch(() => {})
  await writeFile(
    resolve(output, 'evidence.json'),
    JSON.stringify(evidence, null, 2),
  )
  console.log(
    JSON.stringify({
      passed: evidence.passed,
      results: results.length,
      error: evidence.error,
      cleanup,
    }),
  )
}
