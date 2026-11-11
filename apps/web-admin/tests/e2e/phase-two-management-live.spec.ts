import { expect, test } from '@playwright/test'
import { derivePasswordVerifier } from '../../fronted/src/utils/auth/password-verifier'
import { consoleModules } from '../../fronted/src/utils/console/modules'

let failedRequests: string[] = []
test.beforeEach(() => {
  failedRequests = []
})

test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return
  console.error('未完成请求：', failedRequests)
  console.error(
    '页面错误提示：',
    await page.getByRole('alert').allTextContents(),
  )
})

/** 固定视窗下通过真实隔离API装配所有管理页，并验证声明式示例与编辑保存。 */
test('第二阶段真实管理页面、示例与智能体编辑闭环', async ({ page }, info) => {
  test.setTimeout(180_000)
  test.skip(process.env.WEB_ADMIN_E2E_LIVE !== '1', '需要专属临时平台')
  const password = process.env.WEB_ADMIN_E2E_PASSWORD
  if (!password) throw new Error('缺少合成管理员密码')
  const base = process.env.WEB_ADMIN_E2E_BASE_URL!
  const username = process.env.WEB_ADMIN_E2E_USERNAME ?? 'foundation-admin'
  const response = await page.request.post(`${base}/api/auth/password-salt`, {
    data: { identifier: username },
  })
  const challenge: { salt: string } = await response.json()
  let authenticated = false
  for (const candidate of [password, `${password}-changed`]) {
    const login = await page.request.post(`${base}/api/auth/login`, {
      data: {
        identifier: username,
        passwordVerifier: await derivePasswordVerifier(
          candidate,
          challenge.salt,
        ),
      },
    })
    if (login.ok()) {
      authenticated = true
      break
    }
  }
  expect(authenticated).toBe(true)
  const errors: string[] = []
  page.on('pageerror', (error) => {
    errors.push(error.message)
    console.error('页面脚本错误：', error.message)
  })
  page.on('requestfailed', (request) => {
    failedRequests.push(
      `${new URL(request.url()).pathname}: ${request.failure()?.errorText ?? '请求失败'}`,
    )
  })
  const content = page.locator('main.console-content')
  for (const module of consoleModules) {
    // 服务页必须等待真实配置加载及组件渲染；仅断言布局壳可见会掩盖异步渲染异常。
    const settingsResponse =
      module.id === 'system.service'
        ? page.waitForResponse(
            (result) =>
              new URL(result.url()).pathname === '/api/admin/settings' &&
              result.request().method() === 'GET',
          )
        : null
    await page.goto(`/#${module.path}`)
    await expect(content).toBeVisible()
    await expect(content).not.toContainText('此模块尚未迁移')
    await expect(content).not.toBeEmpty()
    if (settingsResponse) {
      const settings = await settingsResponse
      expect(settings.ok(), await settings.text()).toBe(true)
      await expect(
        content.getByRole('heading', { name: '服务', exact: true }),
      ).toBeVisible()
      await expect(
        content.locator('.settings-card').filter({
          has: page.getByRole('heading', { name: 'OAuth', exact: true }),
        }),
      ).toBeVisible()
    }
    expect(errors, `模块 ${module.id} 不应出现页面脚本异常`).toEqual([])
    await page.screenshot({
      path: info.outputPath(`module-${module.id}.png`),
      fullPage: true,
    })
  }
  const initializing = page.waitForResponse(
    (result) =>
      new URL(result.url()).pathname === '/api/admin/agents/initialize' &&
      result.request().method() === 'POST',
    { timeout: 45_000 },
  )
  // 与旧端一致，首次资源使用自动初始化；显式“复制新版示例”是另一项有副作用的操作。
  await page.goto('/#/agents')
  const initialized = await initializing
  expect(initialized.ok(), await initialized.text()).toBe(true)
  await expect(
    page
      .getByRole('row')
      .filter({ has: page.getByText('Excel 办公助手', { exact: true }) }),
  ).toBeVisible({ timeout: 45_000 })
  await expect(
    page
      .getByRole('row')
      .filter({ has: page.getByText('PPT 演示助手', { exact: true }) }),
  ).toBeVisible()
  await page.getByRole('button', { name: '新增智能体', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog
    .getByRole('textbox', { name: '名称', exact: true })
    .fill('浏览器合成组合')
  await dialog
    .getByRole('textbox', { name: '用途说明', exact: true })
    .fill('这是由用户编辑的普通组合，不绑定特定办公场景。')
  await dialog
    .getByRole('textbox', { name: '工作要求', exact: true })
    .fill('只回答本次合成资料，不调用外部模型或工具。')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(
    page
      .getByRole('row')
      .filter({ has: page.getByText('浏览器合成组合', { exact: true }) }),
  ).toBeVisible()
  await page.reload()
  await expect(
    page
      .getByRole('row')
      .filter({ has: page.getByText('浏览器合成组合', { exact: true }) }),
  ).toBeVisible()
  expect(errors).toEqual([])
})
