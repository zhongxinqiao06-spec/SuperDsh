import { expect, test, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import type { QuickProject } from '../../fronted/src/types/studio/quick'
import { grantCreationBudget, loginIsolatedAccount } from './live-auth'

/** 浏览器、API、事务和媒体队列真实运行；仅供应商传输由隔离替身接管。 */
test('作品分类与快速视频：预检、候选、恢复、收藏和进入分镜', async ({
  page,
}) => {
  test.skip(process.env.WEB_ADMIN_E2E_LIVE !== '1')
  test.setTimeout(240_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  let headers = await login(page)
  const adminHeaders = headers
  const connection = await page.request.post('/api/admin/models/connections', {
    headers,
    data: {
      name: '快速验收供应商',
      adapter: 'openai-completions',
      baseUrl:
        'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      apiKey: 'synthetic',
    },
  })
  expect(connection.ok(), await connection.text()).toBeTruthy()
  const connectionId = (await connection.json()).id
  for (const inputMode of ['text', 'reference']) {
    const configuration = await page.request.post(
      '/api/admin/models/configurations',
      {
        headers,
        data: {
          name: inputMode === 'text' ? '受控文本视频' : '受控参考视频',
          connectionId,
          capability: 'video.generate',
          modelId: 'synthetic-video',
          parameters: { inputMode },
        },
      },
    )
    expect(configuration.ok(), await configuration.text()).toBeTruthy()
    if (inputMode === 'text') {
      const id = (await configuration.json()).id
      expect(
        (
          await page.request.put(
            '/api/studio/defaults/video.generate?configuration=' + id,
            { headers },
          )
        ).ok(),
      ).toBeTruthy()
    }
  }
  const username = 'quick-' + randomUUID().slice(0, 12)
  const password = randomUUID() + '!'
  const userResponse = await page.request.post('/api/admin/users', {
    headers: adminHeaders,
    data: {
      username,
      password,
      displayName: '快速创作隔离用户',
      roles: ['entertainment_creator'],
    },
  })
  expect(userResponse.ok(), await userResponse.text()).toBeTruthy()
  const user = await userResponse.json()
  await grantCreationBudget(page.request, adminHeaders, user.userId, 40)
  const firstLogin = await loginIsolatedAccount(
    page.request,
    username,
    password,
  )
  expect(firstLogin.ok()).toBeTruthy()
  const restricted = {
    authorization: 'Bearer ' + (await firstLogin.json()).accessToken,
  }
  expect(
    (
      await page.request.post('/api/auth/change-password', {
        headers: restricted,
        data: { newPassword: password },
      })
    ).ok(),
  ).toBeTruthy()
  await page.context().clearCookies()
  await page.evaluate(() => {
    localStorage.clear()
    sessionStorage.clear()
  })
  headers = await login(page, username, password)
  await page.goto('/#/entertainment/works')
  await expect(
    page.getByRole('heading', { name: '我的作品', exact: true }),
  ).toBeVisible()
  await page.getByRole('tab', { name: '快速视频', exact: true }).click()
  await expect(page.getByText('此分类暂无作品', { exact: false })).toBeVisible()

  await page.goto('/#/entertainment')
  await page.getByRole('link', { name: '快速创作', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: '快速创作', exact: true }),
  ).toBeVisible()
  const list = () =>
    page.request
      .get('/api/studio/works?mode=quick', { headers })
      .then((response) => response.json())
  expect((await list()).total).toBe(0)
  await page.getByLabel('快速作品名称').fill('隔离快速视频')
  await page.getByLabel('视频提示词').fill('雨后清晨，列车缓缓驶入安静的车站')
  await screenshotMatrix(page, 'quick-empty')
  await page.getByRole('button', { name: '生成一条视频' }).click()
  const plan = page.getByRole('dialog', { name: '制作前检查', exact: true })
  await expect(plan).toBeVisible()
  const works = await list()
  expect(works.total).toBe(1)
  const id = works.items[0].id as string
  const path = '/api/studio/projects/' + id
  const read = async (): Promise<QuickProject> =>
    (await page.request.get(path + '/quick', { headers })).json()
  const expectedPoints = (await read()).draft.durationSeconds * 20
  await expect(plan.getByText(`本次上限 ${expectedPoints} 点`)).toBeVisible()
  expect((await read()).jobs).toHaveLength(0)
  await expect(plan.getByText('受控文本视频', { exact: false })).toBeVisible()
  await plan.getByRole('button', { name: '确认用量并提交' }).click()
  const offer = page.getByRole('dialog', { name: '创作点不足' })
  await expect(
    offer.getByText('本次生成需要 100 点，当前可用 40 点，还差 60 点。'),
  ).toBeVisible()
  expect((await read()).jobs).toHaveLength(0)
  await expect(offer.locator('.membership-plan-card')).toHaveCount(3)
  await expect
    .poll(() =>
      offer
        .locator('img')
        .evaluateAll((images) =>
          images.every(
            (img) =>
              img instanceof HTMLImageElement &&
              img.complete &&
              img.naturalWidth > 0,
          ),
        ),
    )
    .toBe(true)
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 850 })
    await expect(
      offer.getByRole('button', { name: '查看会员办理' }),
    ).toBeInViewport()
    await page.screenshot({
      path:
        process.env.WEB_ADMIN_VALIDATION_DIR +
        '/membership-offer-' +
        width +
        '.png',
      animations: 'disabled',
    })
  }
  await offer.getByRole('button', { name: /创作会员/ }).click()
  await offer.getByRole('button', { name: '查看会员办理' }).click()
  await expect(page).toHaveURL(/account\/plans\?.*plan=/)
  await expect(page.getByRole('button', { name: /创作会员/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await grantCreationBudget(page.request, adminHeaders, user.userId, 360)
  await page.goto('/#/entertainment/quick/' + id)
  await expect(page.getByLabel('视频提示词')).toHaveValue(
    '雨后清晨，列车缓缓驶入安静的车站',
  )
  await page.getByRole('button', { name: '生成一条视频' }).click()
  await plan.getByRole('button', { name: '确认用量并提交' }).click()
  await expect
    .poll(async () => (await read()).jobs[0]?.state, { timeout: 30_000 })
    .toBe('ready')
  await expect(
    page.getByRole('button', { name: '下载视频', exact: true }),
  ).toBeVisible()
  expect((await read()).jobs).toHaveLength(1)
  const firstCandidate = (await read()).jobs[0]!
  expect(firstCandidate.candidateNumber).toBe(1)
  expect(firstCandidate.quotedPoints).toBe(expectedPoints)
  await expect(
    page.getByText(`任务锁定报价 · ${expectedPoints} 点`),
  ).toBeVisible()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载视频', exact: true }).click()
  expect((await download).suggestedFilename()).toContain('.mp4')
  await page.getByRole('button', { name: '收藏到素材库', exact: true }).click()
  await expect(
    page.getByRole('button', { name: '已收藏', exact: true }),
  ).toBeDisabled()
  await screenshotMatrix(page, 'quick-ready')
  // 页面轮询和重新进入保留候选，不产生第二笔收费请求。
  await page.reload()
  await expect(
    page.getByRole('button', { name: '下载视频', exact: true }),
  ).toBeVisible()
  expect((await read()).jobs).toHaveLength(1)
  await page.getByRole('button', { name: '生成一条视频' }).click()
  await expect(
    plan.getByRole('button', { name: '确认用量并提交' }),
  ).toBeDisabled()
  await plan.getByRole('button', { name: '取消', exact: true }).click()
  // 通过正式上传和个人库重新选择固定版本；参考模式的预检读取真实图片。
  await page.getByRole('tab', { name: '图生视频', exact: true }).click()
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1024
    const context = canvas.getContext('2d')!
    context.fillStyle = '#486e75'
    context.fillRect(0, 0, 1024, 1024)
    return canvas.toDataURL('image/png').split(',')[1]!
  })
  await page.locator('input[type="file"]').setInputFiles({
    name: '隔离车站参考.png',
    mimeType: 'image/png',
    buffer: Buffer.from(image, 'base64'),
  })
  const remove = page.getByRole('button', {
    name: '移除参考：隔离车站参考',
    exact: true,
  })
  await expect(remove).toBeEnabled()
  await remove.click()
  await page.getByRole('button', { name: '从素材库选', exact: true }).click()
  const picker = page.getByRole('dialog', {
    name: '选择视频参考素材',
    exact: true,
  })
  await picker.getByRole('button', { name: '选择', exact: true }).click()
  await picker
    .getByRole('button', { name: '使用所选素材', exact: true })
    .click()
  await expect(remove).toBeVisible()
  await page.getByRole('button', { name: '生成一条视频' }).click()
  await expect(
    plan.getByText('输入参考图 1 张', { exact: false }),
  ).toBeVisible()
  await plan.getByRole('button', { name: '确认用量并提交' }).click()
  await expect
    .poll(
      async () =>
        (await read()).jobs.filter((job) => job.state === 'ready').length,
      { timeout: 30_000 },
    )
    .toBe(2)
  await remove.click()
  await page.getByRole('tab', { name: '文生视频', exact: true }).click()
  await page.getByLabel('视频提示词').fill('等待取消：山间列车停在站台')
  await page.getByRole('button', { name: '生成一条视频' }).click()
  await plan.getByRole('button', { name: '确认用量并提交' }).click()
  await expect
    .poll(
      async () => (await read()).jobs.some((job) => job.state === 'polling'),
      { timeout: 30_000 },
    )
    .toBeTruthy()
  await expect(
    page.getByRole('button', { name: '取消任务', exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: '取消任务', exact: true }).click()
  await page.getByRole('button', { name: '确认取消', exact: true }).click()
  await expect
    .poll(async () =>
      (await read()).jobs.some((job) => job.state === 'cancelled'),
    )
    .toBeTruthy()
  await page.getByLabel('视频提示词').fill('受理未知：海边灯塔')
  await page.getByRole('button', { name: '生成一条视频' }).click()
  await plan.getByRole('button', { name: '确认用量并提交' }).click()
  await expect
    .poll(
      async () => (await read()).jobs.some((job) => job.state === 'unknown'),
      { timeout: 30_000 },
    )
    .toBeTruthy()
  await page.getByRole('button', { name: '核对任务', exact: true }).click()
  const recovery = page.getByRole('dialog', {
    name: '核对任务 · 快速视频',
    exact: true,
  })
  await recovery
    .getByLabel('核对依据', { exact: true })
    .fill('隔离供应商核对：本次请求没有受理。')
  await recovery
    .getByText('我已在供应商侧确认本次请求未受理', { exact: true })
    .click()
  await recovery.getByRole('button', { name: '记录未受理结论' }).click()
  await expect
    .poll(async () =>
      (await read()).jobs.some((job) => job.state === 'unaccepted'),
    )
    .toBeTruthy()
  await recovery.getByRole('button', { name: '关闭', exact: true }).click()
  await page
    .getByRole('group', { name: '视频候选' })
    .getByRole('button')
    .filter({ hasText: '已完成' })
    .first()
    .click()
  await expect(
    page.getByRole('button', { name: '下载视频', exact: true }),
  ).toBeVisible()
  const beforePromotion = await read()
  expect(beforePromotion.jobs.map((job) => job.candidateNumber)).toEqual([
    4, 3, 2, 1,
  ])
  expect(
    beforePromotion.jobs.find((job) => job.id === firstCandidate.id)
      ?.candidateNumber,
  ).toBe(1)
  await page
    .getByRole('button', { name: '继续到分镜创作', exact: true })
    .click()
  await page.getByRole('button', { name: '进入分镜创作', exact: true }).click()
  await expect(page).toHaveURL(new RegExp('/entertainment/' + id))
  const promoted = await read()
  expect(promoted.creationMode).toBe('storyboard')
  expect(promoted.jobs).toHaveLength(beforePromotion.jobs.length)
  // 真实目录将同一作品移入分镜分类，系列卡片与已有作品等高。
  const series = await page.request.post('/api/studio/series', {
    headers,
    data: {
      title: '隔离长标题系列短剧：一段跨越四季的旅行',
      requestKey: randomUUID(),
      plannedEpisodes: 6,
      narrativeMode: 'continuous',
    },
  })
  expect(series.ok(), await series.text()).toBeTruthy()
  await page.goto('/#/entertainment/works')
  await expect(page.getByText('隔离快速视频', { exact: true })).toBeVisible()
  await screenshotMatrix(page, 'works-classification')
  await page.getByRole('tab', { name: '快速视频', exact: true }).click()
  await expect(page.getByText('此分类暂无作品', { exact: false })).toBeVisible()
  await page.getByRole('tab', { name: '系列短剧', exact: true }).click()
  await expect(
    page.getByRole('link', {
      name: '隔离长标题系列短剧：一段跨越四季的旅行',
      exact: true,
    }),
  ).toBeVisible()
  // 通过正式 RBAC 收回写权限，同一所有者仍能预览候选，写接口服务端拒绝。
  const roleResponse = await page.request.post('/api/admin/roles', {
    headers: adminHeaders,
    data: {
      name: '快速验收只读-' + randomUUID().slice(0, 8),
      permissions: [
        'products.entertainment',
        'studio.projects.read',
        'studio.assets.read',
      ],
    },
  })
  expect(roleResponse.ok(), await roleResponse.text()).toBeTruthy()
  const role = await roleResponse.json()
  expect(
    (
      await page.request.patch('/api/admin/users/' + user.userId, {
        headers: adminHeaders,
        data: { roles: [role.id] },
      })
    ).ok(),
  ).toBeTruthy()
  await page.context().clearCookies()
  await page.evaluate(() => {
    localStorage.clear()
    sessionStorage.clear()
  })
  headers = await login(page, username, password)
  await page.goto('/#/entertainment/quick/' + id)
  await page
    .getByRole('group', { name: '视频候选' })
    .getByRole('button')
    .filter({ hasText: '已完成' })
    .first()
    .click()
  await expect(
    page.getByRole('button', { name: '下载视频', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: '保存草稿', exact: true }),
  ).toHaveCount(0)
  await expect(page.getByLabel('视频提示词')).toBeDisabled()
  await expect(
    page.getByRole('button', { name: '生成一条视频', exact: true }),
  ).toBeDisabled()
  expect(
    (
      await page.request.put(path + '/quick', {
        headers,
        data: {
          revision: promoted.revision,
          requestKey: randomUUID(),
          title: '不应写入',
          draft: promoted.draft,
        },
      })
    ).status(),
  ).toBe(403)
  await page.screenshot({
    path: process.env.WEB_ADMIN_VALIDATION_DIR + '/quick-readonly.png',
    fullPage: true,
  })
  expect(errors).toEqual([])
})

async function login(
  page: Page,
  username = process.env.WEB_ADMIN_E2E_USERNAME ?? 'foundation-admin',
  password = process.env.WEB_ADMIN_E2E_PASSWORD!,
) {
  await page.goto('/?isolated-login=' + randomUUID() + '#/login', {
    waitUntil: 'domcontentloaded',
    timeout: 90_000,
  })
  await page.getByLabel('用户名或邮箱').fill(username)
  await page.getByLabel('密码', { exact: true }).fill(password)
  const signed = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/auth/login') &&
      response.request().method() === 'POST',
  )
  await page.getByRole('button', { name: '登录 ↵', exact: true }).click()
  const response = await signed
  expect(response.ok(), await response.text()).toBeTruthy()
  return { authorization: 'Bearer ' + (await response.json()).accessToken }
}

/** 四档宽度均检查实际横向溢出，宽屏另检查左右容器同高与固定块标题。 */
async function screenshotMatrix(page: Page, prefix: string) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate(
      (value) =>
        document.documentElement.classList.toggle('dark', value === 'dark'),
      theme,
    )
    for (const width of [390, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: 1000 })
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        )
        .toBeTruthy()
      if (prefix.startsWith('quick') && width >= 1280) {
        const boxes = await page
          .locator('.quick-panel')
          .evaluateAll((panels) =>
            panels.map((panel) => panel.getBoundingClientRect().height),
          )
        expect(Math.abs(boxes[0]! - boxes[1]!)).toBeLessThanOrEqual(1)
      }
      if (prefix === 'works-classification' && width >= 1280) {
        const cards = await page
          .locator('.studio-project-card')
          .evaluateAll((elements) =>
            elements.map((element) => element.getBoundingClientRect().height),
          )
        expect(Math.max(...cards) - Math.min(...cards)).toBeLessThanOrEqual(1)
        const controls = await page
          .locator('.filter-bar > *')
          .evaluateAll((elements) =>
            elements.map((element) => element.getBoundingClientRect().top),
          )
        expect(
          Math.max(...controls) - Math.min(...controls),
        ).toBeLessThanOrEqual(1)
      }
      await page.screenshot({
        path:
          process.env.WEB_ADMIN_VALIDATION_DIR +
          '/' +
          prefix +
          '-' +
          theme +
          '-' +
          width +
          '.png',
        animations: 'disabled',
        timeout: 45000,
      })
      if (prefix.startsWith('quick') && width < 900) {
        await page.locator('.quick-results').scrollIntoViewIfNeeded()
        await page.screenshot({
          path:
            process.env.WEB_ADMIN_VALIDATION_DIR +
            '/' +
            prefix +
            '-' +
            theme +
            '-' +
            width +
            '-results.png',
          animations: 'disabled',
          timeout: 45000,
        })
        await page
          .getByRole('heading', { name: '快速创作', exact: true })
          .scrollIntoViewIfNeeded()
      }
    }
  }
  await page.evaluate(() => document.documentElement.classList.remove('dark'))
}
