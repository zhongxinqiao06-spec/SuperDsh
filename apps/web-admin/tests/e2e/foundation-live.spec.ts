import { expect, test } from '@playwright/test'
import { createPasswordVerifier } from '../../fronted/src/utils/auth/password-verifier'
import { loginIsolatedAccount } from './live-auth'

test('真实新平台：配置初始化后登录、刷新、用户与角色菜单闭环', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000)
  test.skip(
    process.env.WEB_ADMIN_E2E_LIVE !== '1',
    '需显式指定独立临时后端；合成fixture结果不替代真实服务验收',
  )
  const username = process.env.WEB_ADMIN_E2E_USERNAME ?? 'foundation-admin'
  const password = process.env.WEB_ADMIN_E2E_PASSWORD
  if (!password)
    throw new Error('真实验收必须提供独立合成账号密码 WEB_ADMIN_E2E_PASSWORD')
  const base = process.env.WEB_ADMIN_E2E_BASE_URL ?? 'http://localhost:5175'
  const configResponse = await request.get(`${base}/api/auth/config`)
  expect(configResponse.ok()).toBeTruthy()
  const config: { needsBootstrap: boolean } = await configResponse.json()
  expect(config.needsBootstrap, '临时服务应已按配置创建验收管理员').toBe(false)
  await page.goto('/#/login')
  await expect(page.getByLabel('初始化令牌')).toHaveCount(0)
  await page.getByLabel('用户名或邮箱').fill(username)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录 ↵', exact: true }).click()
  await page.getByRole('link', { name: /星桥办公/ }).click()
  await page.getByRole('link', { name: /管理后台/ }).click()
  await expect(
    page.getByRole('heading', { name: '看板', exact: true }),
  ).toBeVisible()
  const sidebar = page.getByRole('navigation', { name: '平台导航' })
  await expect(
    sidebar.getByRole('link', { name: '平台总览', exact: true }),
  ).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('live-console.png') })
  const roleName = `验收角色-${Date.now()}`
  await page.goto('/#/access/roles')
  await page.getByRole('button', { name: '创建角色', exact: true }).click()
  const roleEditor = page.getByRole('dialog')
  await roleEditor.getByLabel('角色名称').fill(roleName)
  await roleEditor
    .getByLabel('说明', { exact: true })
    .fill('独立临时库的合成角色')
  await roleEditor.getByText('users.read', { exact: true }).click()
  await expect(
    roleEditor.getByRole('checkbox', { name: /users.read/ }),
  ).toBeChecked()
  await roleEditor.getByRole('button', { name: '保存', exact: true }).click()
  const roleRow = page
    .locator('.role-card')
    .filter({ has: page.getByRole('heading', { name: roleName, exact: true }) })
  await expect(roleRow).toBeVisible()
  await roleRow.getByRole('button', { name: '编辑', exact: true }).click()
  await roleEditor.getByLabel('说明', { exact: true }).fill('已编辑合成角色')
  await roleEditor.getByRole('button', { name: '保存', exact: true }).click()
  await expect(roleRow).toContainText('已编辑合成角色')
  await page.reload()
  await expect(
    page.getByRole('heading', { name: '角色与权限', exact: true }),
  ).toBeVisible()
  await page.goto('/#/access/users')
  await expect(
    page.getByRole('heading', { name: '用户管理', exact: true }),
  ).toBeVisible()
  const createdName = `验收用户-${Date.now()}`
  await page.getByRole('button', { name: '创建用户', exact: true }).click()
  const editor = page.getByRole('dialog')
  await editor.getByLabel('用户名', { exact: true }).fill(`check-${Date.now()}`)
  await editor.getByLabel('显示名称').fill(createdName)
  await editor.getByLabel('初始密码').fill('Synthetic-check-password!')
  await editor.getByRole('button', { name: '保存', exact: true }).click()
  await expect(
    page.getByRole('row', { name: new RegExp(createdName) }),
  ).toBeVisible()
  const createdRow = page.getByRole('row', { name: new RegExp(createdName) })
  await createdRow.getByRole('button', { name: '禁用', exact: true }).click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '确认', exact: true })
    .click()
  await expect(createdRow).toContainText('已禁用')
  await createdRow.getByRole('button', { name: '启用', exact: true }).click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '确认', exact: true })
    .click()
  await expect(createdRow).toContainText('已激活')
  await page
    .getByRole('row', { name: new RegExp(createdName) })
    .getByRole('button', { name: '删除', exact: true })
    .click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '确认', exact: true })
    .click()
  await expect(createdRow).toContainText('已删除')
  await createdRow.getByRole('button', { name: '恢复', exact: true }).click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '确认', exact: true })
    .click()
  await expect(createdRow).toContainText('已激活')
  await createdRow
    .getByRole('button', { name: '本人重置密码', exact: true })
    .click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '确认', exact: true })
    .click()
  await expect(
    page.getByText(
      '请用户在登录页用自己的恢复码重置密码。管理员无法设置他人的新密码。',
      { exact: true },
    ),
  ).toBeVisible()
  await page.goto('/#/access/roles')
  await expect(
    page.getByRole('heading', { name: '角色与权限', exact: true }),
  ).toBeVisible()
  const builtinRole = page
    .locator('.role-card')
    .filter({ has: page.getByText('内置 · 只读', { exact: true }) })
    .first()
  await expect(builtinRole).toBeVisible()
  await builtinRole
    .getByRole('button', { name: '查看权限', exact: true })
    .click()
  await expect(
    roleEditor.getByRole('button', { name: '保存', exact: true }),
  ).toHaveCount(0)
  await roleEditor.getByRole('button', { name: '关闭', exact: true }).click()
  await roleRow.getByRole('button', { name: '删除', exact: true }).click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '确认删除', exact: true })
    .click()
  await expect(roleRow).toHaveCount(0)
  await page.goto('/#/access/menus')
  await page.getByRole('textbox', { name: '搜索菜单' }).fill('平台总览')
  await page
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: /平台总览$/ }) })
    .getByRole('button', { name: '编辑', exact: true })
    .click()
  await page
    .getByRole('dialog')
    .getByLabel('名称', { exact: true })
    .fill('验收总览')
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '保存', exact: true })
    .click()
  const platformGroup = sidebar.getByRole('button', {
    name: '平台管理',
    exact: true,
  })
  await platformGroup.click()
  await expect(
    sidebar.getByRole('link', { name: '验收总览', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: '新增分组', exact: true }),
  ).toBeEnabled()
  await page.getByRole('button', { name: '恢复默认', exact: true }).click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '确认恢复', exact: true })
    .click()
  await expect(page.getByRole('cell', { name: /平台总览$/ })).toBeVisible()
  if ((await platformGroup.getAttribute('aria-expanded')) !== 'true')
    await platformGroup.click()
  await expect(
    sidebar.getByRole('link', { name: '平台总览', exact: true }),
  ).toBeVisible()
  const secondLogin = await loginIsolatedAccount(
    request,
    username,
    password,
    'desktop',
  )
  expect(secondLogin.ok()).toBeTruthy()
  await page.goto('/#/account/security')
  await expect(page.getByRole('cell', { name: /当前/ })).toBeVisible()
  await page.getByRole('button', { name: '撤销', exact: true }).first().click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '确认撤销', exact: true })
    .click()
  await expect(
    page.getByRole('button', { name: '撤销', exact: true }),
  ).toHaveCount(0)
  await page.getByRole('button', { name: '重置密码', exact: true }).click()
  const changedPassword = `${password}-changed`
  await page
    .getByRole('dialog')
    .getByLabel('新密码', { exact: true })
    .fill(changedPassword)
  await page
    .getByRole('dialog')
    .getByLabel('确认密码', { exact: true })
    .fill(changedPassword)
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '保存', exact: true })
    .click()
  await expect(
    page.getByRole('heading', { name: '登录 星桥智能平台' }),
  ).toBeVisible()
  await page.getByLabel('用户名或邮箱').fill(username)
  await page.getByLabel('密码', { exact: true }).fill(changedPassword)
  await page.getByRole('button', { name: '登录 ↵', exact: true }).click()
  // 改密后的登录恢复原安全页深链，再显式进入产品选择。
  await expect(page).toHaveURL(/#\/account\/security$/)
  await page.getByRole('link', { name: '切换产品' }).click()
  await page.getByRole('link', { name: /星桥办公/ }).click()
  await page.getByRole('link', { name: /管理后台/ }).click()
  await expect(
    page.getByRole('heading', { name: '看板', exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await page.getByRole('button', { name: '确认退出', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: '登录 星桥智能平台' }),
  ).toBeVisible()
  await page.reload()
  await expect(
    page.getByRole('heading', { name: '登录 星桥智能平台' }),
  ).toBeVisible()
  // 验证改密后将隔离管理员恢复为初始凭据，后续产品回归可以独立运行。
  const signedIn = await loginIsolatedAccount(
    request,
    username,
    changedPassword,
  )
  expect(signedIn.ok()).toBeTruthy()
  const { accessToken } = await signedIn.json()
  const original = await createPasswordVerifier(password)
  const restored = await request.post(`${base}/api/auth/change-password`, {
    headers: { authorization: 'Bearer ' + accessToken },
    data: {
      newPasswordVerifier: original.passwordVerifier,
      newPasswordSalt: original.passwordSalt,
    },
  })
  expect(restored.status()).toBe(204)
})
