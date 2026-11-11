import { expect, test } from '@playwright/test'
import { derivePasswordVerifier } from '../../fronted/src/utils/auth/password-verifier'

test.afterEach(async ({ page }) => {
  if (process.env.WEB_ADMIN_E2E_LIVE !== '1') return
  // 本用例的 API 登录与页面共享 Cookie，结束时注销自身会话，避免污染后续会话数断言。
  const base = process.env.WEB_ADMIN_E2E_BASE_URL ?? 'http://localhost:5175'
  const response = await page.request.post(`${base}/api/auth/logout`, {
    headers: { Origin: base },
    data: {},
  })
  expect(response.status()).toBe(204)
})

test('真实隔离文件：一次性预览、刷新与有摘要保护的编辑', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(90_000)
  test.skip(
    process.env.WEB_ADMIN_E2E_LIVE !== '1',
    '只运行独立临时平台，不连接开发中的用户服务',
  )
  const username = process.env.WEB_ADMIN_E2E_USERNAME ?? 'foundation-admin'
  const password = process.env.WEB_ADMIN_E2E_PASSWORD
  if (!password) throw new Error('缺少独立合成账号密码')
  const base = process.env.WEB_ADMIN_E2E_BASE_URL ?? 'http://localhost:5175'
  const salt = await page.request.post(`${base}/api/auth/password-salt`, {
    data: { identifier: username },
  })
  expect(salt.ok()).toBeTruthy()
  const challenge: { salt: string } = await salt.json()
  // foundation 用例会验证改密；两种均是本次独立测试配置，不尝试真实账号。
  let token = ''
  for (const candidate of [password, `${password}-changed`]) {
    const response = await page.request.post(`${base}/api/auth/login`, {
      data: {
        identifier: username,
        passwordVerifier: await derivePasswordVerifier(
          candidate,
          challenge.salt,
        ),
      },
    })
    if (response.ok()) {
      token = ((await response.json()) as { accessToken: string }).accessToken
      break
    }
  }
  expect(token).toBeTruthy()
  const headers = { Authorization: `Bearer ${token}` }
  // 设备清单是只读入口；先显式准备本次合成账号的受管工作区。
  const prepared = await page.request.post(`${base}/api/server-agent`, {
    headers,
    data: {},
  })
  expect(prepared.ok(), await prepared.text()).toBe(true)
  const inventory = await page.request.get(`${base}/api/connectors`, {
    headers,
  })
  expect(inventory.ok()).toBe(true)
  const devices: { connectors: { id: string; executorKind: string }[] } =
    await inventory.json()
  const native = devices.connectors.find(
    (item) => item.executorKind === 'server-agent',
  )
  expect(native).toBeTruthy()
  const connector = native!.id
  const path = `preview-contract-${Date.now()}.txt`
  const prefix = `${base}/api/connectors/${encodeURIComponent(connector)}/fs`
  expect(
    (
      await page.request.post(prefix + '/write', {
        headers,
        data: { path, content: '独立窗口真实预览正文' },
      })
    ).ok(),
  ).toBeTruthy()
  const issued = await page.request.post(prefix + '/preview-token', {
    headers,
    data: { path },
  })
  const access: { previewToken: string } = await issued.json()
  const address = `/#/preview?${new URLSearchParams({ previewToken: access.previewToken, name: path })}`
  await page.goto(address)
  await expect(
    page.getByText('独立窗口真实预览正文', { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: '编辑', exact: true }),
  ).toHaveCount(0)
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await expect(
    page.getByText('独立窗口真实预览正文', { exact: true }),
  ).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath('scoped-file-preview.png'),
  })
  const replay = await context.newPage()
  await replay.goto(address)
  await expect(
    replay.getByText('预览访问已过期', { exact: true }),
  ).toBeVisible()
  await replay.close()
  await page.goto(
    `/#/preview?${new URLSearchParams({ connectorId: connector, path, name: path })}`,
  )
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  await page
    .getByRole('textbox', { name: '文件内容编辑器' })
    .fill('独立窗口已保存正文')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(
    page.getByText('独立窗口已保存正文', { exact: true }),
  ).toBeVisible()
  const actual = await page.request.post(prefix + '/readText', {
    headers,
    data: { path },
  })
  expect(((await actual.json()) as { content: string }).content).toBe(
    '独立窗口已保存正文',
  )
})
