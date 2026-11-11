import { expect, test } from '@playwright/test'
import { installParityFixture } from '../parity/ui-fixture'

/** 必填校验必须阻止写请求，不能让合成成功响应掩盖空资源创建。 */
for (const scenario of [
  {
    path: '/agents',
    action: '新增智能体',
    endpoint: '/admin/agents',
    message: '请填写智能体名称、用途说明和工作要求',
  },
  {
    path: '/knowledge',
    action: '新增知识库',
    endpoint: '/admin/knowledge-bases',
    message: '请填写知识库名称和用途说明',
  },
  {
    path: '/skills',
    action: '新增技能',
    endpoint: '/admin/skills',
    message: '请填写技能名称、用途说明和执行要求',
  },
  {
    path: '/tools',
    action: '新增工具',
    endpoint: '/admin/tools',
    message: '请选择工具实现，并填写名称和用途说明',
  },
]) {
  test(`${scenario.action}的空白草稿保留且不发写请求`, async ({ page }) => {
    const state = await installParityFixture(page)
    await page.goto(`/#${scenario.path}`)
    await page
      .getByRole('button', { name: scenario.action, exact: true })
      .click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(dialog).toBeVisible()
    await expect(
      dialog.getByText(scenario.message, { exact: true }),
    ).toBeVisible()
    expect(state.requests).not.toContain(`POST ${scenario.endpoint}`)
  })
}

/** 真实 Vue 浏览器回归使用合成传输，专门验证旧端差分发现的控制和只读规则。 */
test('外部会话接管确认前不可写，确认接管可写，取消接管恢复只读', async ({
  page,
}) => {
  const state = await installParityFixture(page)
  state.takeover = false
  await page.routeWebSocket('**/api/sessions/*/ws*', () => {})
  await page.goto('/#/workspace/session/parity-session')
  const draft = page.getByRole('textbox', { name: '任务草稿' })
  await expect(draft).toBeDisabled()
  await page.getByText('接管', { exact: true }).click()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await expect(draft).toBeDisabled()
  expect(state.requests.filter((value) => value.endsWith('/takeover'))).toEqual(
    [],
  )
  await page.getByText('接管', { exact: true }).click()
  await page.getByRole('button', { name: '确认', exact: true }).click()
  await expect(draft).toBeEnabled()
  expect(state.requests).toContain('POST /sessions/parity-session/takeover')
  await page.getByText('接管', { exact: true }).click()
  await page.getByRole('button', { name: '确认', exact: true }).click()
  await expect(draft).toBeDisabled()
  expect(state.requests).toContain('DELETE /sessions/parity-session/takeover')
})

test('内置角色只读，不显示保存也不发修改请求', async ({ page }) => {
  const state = await installParityFixture(page)
  await page.goto('/#/access/roles')
  await page.getByRole('button', { name: '查看权限' }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(
    dialog.getByRole('button', { name: '保存', exact: true }),
  ).toHaveCount(0)
  await expect(dialog.getByRole('textbox', { name: '角色名称' })).toBeDisabled()
  await expect(dialog.getByRole('checkbox').first()).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  expect(
    state.requests.some((value) => /^(PATCH|PUT) \/admin\/roles/.test(value)),
  ).toBe(false)
})

test('模型供应商列表是独立弹窗，关闭后保留模型搜索', async ({ page }) => {
  await installParityFixture(page)
  await page.goto('/#/models')
  await page
    .getByRole('textbox', { name: '搜索模型配置' })
    .fill('synthetic-search')
  await page.getByRole('button', { name: '供应商连接', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '供应商连接', exact: true })
  await expect(dialog).toBeVisible()
  await expect(
    dialog.getByRole('button', { name: '新增连接', exact: true }),
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(page.getByRole('textbox', { name: '搜索模型配置' })).toHaveValue(
    'synthetic-search',
  )
})

test('服务分区编辑失败保留草稿，取消后重新打开读取已保存值', async ({
  page,
}) => {
  await installParityFixture(page)
  await page.route('**/api/admin/settings', async (route) => {
    if (route.request().method() === 'PATCH')
      return route.fulfill({
        status: 409,
        json: { detail: '配置已在另一窗口修改', code: 'revision_conflict' },
      })
    await route.fallback()
  })
  await page.goto('/#/system/service')
  await page
    .locator('.settings-card')
    .filter({
      has: page.getByRole('heading', {
        name: '邮箱验证 · Resend',
        exact: true,
      }),
    })
    .getByRole('button', { name: '编辑配置' })
    .click()
  const dialog = page.getByRole('dialog')
  await dialog
    .getByRole('textbox', { name: '发件人地址' })
    .fill('Synthetic <test@example.invalid>')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toContainText('配置已在另一窗口修改')
  await expect(dialog.getByRole('textbox', { name: '发件人地址' })).toHaveValue(
    'Synthetic <test@example.invalid>',
  )
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await page
    .locator('.settings-card')
    .filter({
      has: page.getByRole('heading', {
        name: '邮箱验证 · Resend',
        exact: true,
      }),
    })
    .getByRole('button', { name: '编辑配置' })
    .click()
  await expect(
    page.getByRole('dialog').getByRole('textbox', { name: '发件人地址' }),
  ).toHaveValue('')
})

test('资料取消编辑不写身份，手机菜单显隐不影响直接访问且偏好可恢复', async ({
  page,
}) => {
  const state = await installParityFixture(page)
  await page.goto('/#/account/profile')
  await page.getByRole('button', { name: '修改昵称', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox', { name: '显示名称' }).fill('未提交昵称')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('button', { name: '修改昵称', exact: true }).click()
  await expect(
    page.getByRole('dialog').getByRole('textbox', { name: '显示名称' }),
  ).toHaveValue('合成管理员')
  expect(state.requests).not.toContain('PUT /auth/me/profile')
  await page.goto('/#/account/mobile')
  await page.getByRole('button', { name: '在侧边栏隐藏', exact: true }).click()
  await expect(
    page.getByRole('link', { name: '手机登录会话', exact: true }),
  ).toHaveCount(0)
  await page.reload()
  await expect(
    page.getByRole('heading', { name: '手机登录会话', exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: '在侧边栏显示', exact: true }).click()
  await expect(
    page.getByRole('link', { name: '手机登录会话', exact: true }),
  ).toBeVisible()
})

test('设备重置保留记录并展示一次性凭据，删除才调用 DELETE', async ({
  page,
}) => {
  await installParityFixture(page)
  const device = {
    id: 'own-desktop',
    userId: 'parity-admin',
    name: '合成桌面',
    connectorKind: 'desktop',
    executorKind: 'desktop',
    status: 'offline',
    deviceOs: 'windows',
    runtimes: [],
  }
  let deleted = false,
    rotations = 0
  await page.route('**/api/connectors', (route) =>
    route.fulfill({ json: { connectors: deleted ? [] : [device] } }),
  )
  await page.route('**/api/connectors/own-desktop/revoke', (route) => {
    rotations++
    return route.fulfill({
      json: {
        connector: device,
        connectorToken: 'synthetic-once-credential',
        tokenPrefix: 'synthetic',
      },
    })
  })
  await page.route('**/api/connectors/own-desktop', (route) => {
    expect(route.request().method()).toBe('DELETE')
    deleted = true
    return route.fulfill({ status: 204 })
  })
  await page.goto('/#/workspace')
  await page
    .locator('.workbench-toolbar')
    .getByRole('button', { name: '设备', exact: true })
    .click()
  await page.getByRole('button', { name: '重置凭据', exact: true }).click()
  await page.getByRole('button', { name: '确认重置', exact: true }).click()
  await expect(
    page.getByRole('textbox', { name: '新的设备凭据', exact: true }),
  ).toHaveValue('synthetic-once-credential')
  expect(rotations).toBe(1)
  expect(deleted).toBe(false)
  await page.getByRole('button', { name: '完成', exact: true }).click()
  await expect(
    page.getByRole('textbox', { name: '新的设备凭据', exact: true }),
  ).toHaveCount(0)
  await expect(
    page.locator('.device-manager').getByText('合成桌面', { exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: '删除设备', exact: true }).click()
  await page.getByRole('button', { name: '确认删除', exact: true }).click()
  await expect(
    page.locator('.device-manager').getByText('合成桌面', { exact: true }),
  ).toHaveCount(0)
  expect(deleted).toBe(true)
})

test('窄屏模型与权限从底部抽屉打开，不挤占输入区', async ({ page }) => {
  await installParityFixture(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#/workspace')
  await page
    .getByRole('button', { name: '模型与权限设置', exact: true })
    .click()
  const drawer = page.getByRole('dialog', {
    name: '模型与权限设置',
    exact: true,
  })
  await expect(drawer).toBeVisible()
  await expect(
    drawer.getByRole('combobox', { name: '模型选择', exact: true }),
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(drawer).not.toBeVisible()
  await expect(page.getByRole('textbox', { name: '任务草稿' })).toBeVisible()
})
