import {
  expect,
  test,
  type Page,
  type APIRequestContext,
} from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { loginIsolatedAccount } from './live-auth'

type Product = 'office' | 'entertainment'

async function apiLogin(
  request: APIRequestContext,
  identifier: string,
  password: string,
) {
  const response = await loginIsolatedAccount(request, identifier, password)
  expect(response.status()).toBe(200)
  return { authorization: 'Bearer ' + (await response.json()).accessToken }
}

async function login(page: Page, identifier: string, password: string) {
  await page.goto('/#/login')
  await page.getByLabel('用户名或邮箱').fill(identifier)
  await page.getByLabel('密码', { exact: true }).fill(password)
  const identity = page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/auth/login') && r.request().method() === 'POST',
  )
  await page.getByRole('button', { name: '登录 ↵', exact: true }).click()
  const response = await identity
  expect(response.status()).toBe(200)
  return { authorization: 'Bearer ' + (await response.json()).accessToken }
}

async function checkWorkspace(
  page: Page,
  product: Product,
  manager: boolean,
  platform: boolean,
  personalModels = platform || product === 'office',
) {
  const nav = page.getByRole('navigation', { name: '平台导航' })
  const name = product === 'office' ? '办公工作台' : '创作工作台'
  await expect(nav.getByRole('button', { name, exact: true })).toBeVisible()
  for (const [title, allowed] of [
    ['能力管理', manager],
    ['产品管理', manager],
    ['平台管理', platform],
    ['个人中心', true],
  ] as const) {
    await expect(
      nav.getByRole('button', { name: title, exact: true }),
    ).toHaveCount(allowed ? 1 : 0)
  }
  if (product === 'entertainment')
    await expect(nav.locator(':scope > :first-child')).toHaveAccessibleName(
      '首页',
    )
  const sections: Record<string, string[]> = {
    [name]:
      product === 'office'
        ? ['智能对话', '历史会话', '我的文件', '我的设备']
        : ['我的作品', '制作任务', '成片交付'],
    个人中心: [
      '账号资料',
      '账号安全',
      '外观设置',
      ...(personalModels ? ['个人模型'] : []),
    ],
  }
  if (product === 'entertainment')
    sections['素材中心'] = ['角色库', '场景库', '道具库', '媒体库']
  if (manager) {
    sections['能力管理'] = ['智能体', '知识库', '技能', '工具', '默认模型']
    sections['产品管理'] = ['产品成员', '菜单配置']
  }
  if (platform)
    sections['平台管理'] = [
      '平台总览',
      '账号与角色',
      '供应商与模型',
      '扩展管理',
      '设备运维',
      '存储与服务',
      '平台审计',
    ]
  for (const [section, titles] of Object.entries(sections)) {
    const group = nav.getByRole('button', { name: section, exact: true })
    if ((await group.getAttribute('aria-expanded')) !== 'true')
      await group.click()
    for (const title of titles)
      await expect(
        nav.getByRole('link', { name: title, exact: true }),
      ).toBeVisible()
    if (section === '个人中心' && !personalModels)
      await expect(
        nav.getByRole('link', { name: '个人模型', exact: true }),
      ).toHaveCount(0)
  }
}

/** 六个独立浏览器上下文用真实页面登录；通过同一个会话同时核对菜单、路由和服务端拒绝。 */
test('五类角色真实登录和跨产品组合授权', async ({ browser, request }) => {
  test.skip(process.env.WEB_ADMIN_E2E_LIVE !== '1', '使用独立平台和数据库')
  test.setTimeout(180_000)
  const baseURL = process.env.WEB_ADMIN_E2E_BASE_URL!
  const administrator = process.env.WEB_ADMIN_E2E_USERNAME ?? 'foundation-admin'
  const adminPassword = process.env.WEB_ADMIN_E2E_PASSWORD!
  const adminHeaders = await apiLogin(request, administrator, adminPassword)
  const pass = randomUUID() + '!'
  for (const roles of [
    ['admin'],
    ['office_admin'],
    ['entertainment_admin'],
    ['member'],
    ['entertainment_creator'],
    ['office_admin', 'entertainment_creator'],
  ]) {
    await test.step(roles.join(' + '), async () => {
      const isSuper = roles.includes('admin')
      const mixed = roles.length > 1
      const office =
        isSuper || roles.includes('office_admin') || roles.includes('member')
      const product: Product = office ? 'office' : 'entertainment'
      const username = isSuper
        ? administrator
        : 'rbac-' + randomUUID().slice(0, 12)
      if (!isSuper) {
        const created = await request.post('/api/admin/users', {
          headers: adminHeaders,
          data: { username, displayName: username, password: pass, roles },
        })
        expect(created.status(), await created.text()).toBe(201)
        const restricted = await apiLogin(request, username, pass)
        expect(
          (
            await request.post('/api/auth/change-password', {
              headers: restricted,
              data: { newPassword: pass },
            })
          ).status(),
        ).toBe(204)
      }
      const context = await browser.newContext({ baseURL })
      try {
        const page = await context.newPage()
        const headers = await login(
          page,
          username,
          isSuper ? adminPassword : pass,
        )
        if (mixed || isSuper)
          await page.getByRole('link', { name: /星桥办公/ }).click()
        const manager = isSuper || roles.includes(product + '_admin')
        await checkWorkspace(page, product, manager, isSuper)
        const params = { product }
        expect(
          (await request.get('/api/admin/menus', { params, headers })).status(),
        ).toBe(manager ? 200 : 403)
        expect(
          (
            await request.get('/api/products/' + product + '/members', {
              headers,
            })
          ).status(),
        ).toBe(manager ? 200 : 403)
        expect(
          (
            await request.get(
              '/api/admin/products/' + product + '/model-defaults',
              { headers },
            )
          ).status(),
        ).toBe(manager ? 200 : 403)
        expect(
          (
            await request.get('/api/admin/agents', { params, headers })
          ).status(),
        ).toBe(manager ? 200 : 403)
        expect(
          (await request.get('/api/admin/users', { headers })).status(),
        ).toBe(isSuper ? 200 : 403)
        if (isSuper || mixed) {
          await page.getByRole('link', { name: '切换产品' }).click()
          await page.getByRole('link', { name: /星桥娱乐/ }).click()
          await checkWorkspace(page, 'entertainment', isSuper, isSuper, true)
        }
        if (mixed) {
          // 同一身份刚刚在办公端有管理权；对娱乐端伪造只读、写入、恢复、发布均不得成功。
          const params = { product: 'entertainment' }
          const revision = (
            await (
              await request.get('/api/admin/menus', {
                params,
                headers: adminHeaders,
              })
            ).json()
          ).version
          expect(
            (
              await request.get('/api/admin/menus', { params, headers })
            ).status(),
          ).toBe(403)
          expect(
            (
              await request.post('/api/admin/menus/reset', {
                params,
                headers,
                data: { version: revision },
              })
            ).status(),
          ).toBe(403)
          expect(
            (
              await request.post('/api/products/entertainment/members', {
                headers,
                data: { identifier: username },
              })
            ).status(),
          ).toBe(403)
          expect(
            (
              await request.put(
                '/api/admin/products/entertainment/model-defaults/chat',
                { headers, data: { configurationId: null } },
              )
            ).status(),
          ).toBe(403)
          expect(
            (
              await request.post('/api/admin/agents/initialize', {
                params,
                headers,
                data: { copyLatest: false },
              })
            ).status(),
          ).toBe(403)
          expect(
            (
              await request.get('/api/admin/models/configurations', { headers })
            ).status(),
          ).toBe(403)
          expect(
            (
              await request.patch(
                '/api/admin/models/connections/synthetic-connection',
                {
                  headers,
                  data: {
                    name: '鉴权验证',
                    adapter: 'openai-completions',
                    baseUrl: 'https://example.invalid',
                    apiKey: 'synthetic-only',
                    revision: 1,
                  },
                },
              )
            ).status(),
          ).toBe(403)
          expect(
            (
              await request.patch('/api/admin/users/synthetic-member', {
                headers,
                data: { roles: ['admin'], revision: 1 },
              })
            ).status(),
          ).toBe(403)
          await page.goto('/#/product/members?product=entertainment')
          await expect(page.getByRole('heading', { name: '403' })).toBeVisible()
          await page.getByRole('link', { name: '切换产品' }).click()
          await page.getByRole('link', { name: /星桥办公/ }).click()
          await checkWorkspace(page, 'office', true, false)
          const members = page.getByRole('navigation', { name: '平台导航' })
          const management = members.getByRole('button', { name: '产品管理' })
          if ((await management.getAttribute('aria-expanded')) !== 'true')
            await management.click()
          await members.getByRole('link', { name: '产品成员' }).click()
          await expect(
            page.getByRole('heading', { name: '产品成员', exact: true }),
          ).toBeVisible()
        }
      } finally {
        await context.close()
      }
    })
  }
})
