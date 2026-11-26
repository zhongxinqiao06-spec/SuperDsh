import { expect, test } from '@playwright/test'
import { newShot } from '../../fronted/src/utils/studio/storyboard'
import type { PersonalProduction } from '../../fronted/src/types/studio/production'
import type { StudioProject } from '../../fronted/src/types/studio/studio'

/** 真实页面与隔离 API/数据库/媒体队列闭环，仅供应商传输受控。 */
test('个人库独立制作、批量预检与取消完整闭环', async ({ page }) => {
  test.setTimeout(240_000)
  test.skip(process.env.WEB_ADMIN_E2E_LIVE !== '1')
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/#/login', { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page
    .getByLabel('用户名或邮箱')
    .fill(process.env.WEB_ADMIN_E2E_USERNAME ?? 'foundation-admin')
  await page
    .getByLabel('密码', { exact: true })
    .fill(process.env.WEB_ADMIN_E2E_PASSWORD!)
  const signed = page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/auth/login') && r.request().method() === 'POST',
  )
  await page.getByRole('button', { name: '登录 ↵', exact: true }).click()
  const headers = {
    authorization: 'Bearer ' + (await (await signed).json()).accessToken,
  }
  const connection = await page.request.post('/api/admin/models/connections', {
    headers,
    data: {
      name: '隔离媒体',
      adapter: 'openai-completions',
      baseUrl:
        'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      apiKey: 'synthetic',
    },
  })
  expect(connection.ok()).toBeTruthy()
  const connectionId = (await connection.json()).id
  for (const [capability, modelId, parameters] of [
    ['image.generate', 'synthetic-image', { size: '1024x1024', maxImages: 1 }],
    ['speech.synthesize', 'synthetic-speech', { voices: 'a,b' }],
    ['video.generate', 'synthetic-video', { inputMode: 'text' }],
  ] as const) {
    const response = await page.request.post(
      '/api/admin/models/configurations',
      {
        headers,
        data: {
          name: capability,
          connectionId,
          capability,
          modelId,
          parameters,
        },
      },
    )
    expect(response.ok(), await response.text()).toBeTruthy()
    const model = await response.json()
    const result = await page.request.put(
      '/api/studio/defaults/' +
        capability +
        '?configuration=' +
        encodeURIComponent(model.id),
      { headers },
    )
    expect(result.ok(), await result.text()).toBeTruthy()
  }
  const asset = await page.request.post('/api/studio/assets', {
    headers,
    data: { name: '个人角色', kind: 'character', description: '蓝色外套' },
  })
  const entity = (await asset.json()).family
  const read = async (): Promise<PersonalProduction> =>
    (
      await page.request.get('/api/studio/entities/' + entity + '/production', {
        headers,
      })
    ).json()
  const projectsBefore = await (
    await page.request.get('/api/studio/projects', { headers })
  ).json()
  await page.goto('/#/entertainment/characters')
  await page
    .getByRole('button', { name: 'AI 制作', exact: true })
    .first()
    .click()
  const dialog = page.getByRole('dialog', { name: '个人素材制作', exact: true })
  await dialog.getByLabel('补充画面要求').fill('简洁场景参考')
  await dialog.getByRole('button', { name: '检查生成方案' }).click()
  const plan = page.getByRole('dialog', { name: '制作前检查', exact: true })
  await expect(plan.getByText('参考图', { exact: false }).first()).toBeVisible()
  expect((await read()).jobs).toHaveLength(0)
  await plan.getByRole('button', { name: '确认用量并提交' }).click()
  await expect
    .poll(async () => (await read()).jobs[0]?.state, { timeout: 30000 })
    .toBe('ready')
  await expect(dialog.locator('img')).toBeVisible()
  await dialog.getByRole('button', { name: '采用并保存新版本' }).click()
  await expect.poll(async () => (await read()).revision).toBe(2)
  expect(
    await (await page.request.get('/api/studio/projects', { headers })).json(),
  ).toEqual(projectsBefore)
  await dialog.getByText('试听与声音', { exact: true }).click()
  await dialog.getByLabel('试听音色').press('ArrowDown')
  await page.getByRole('option', { name: 'b', exact: true }).click()
  await dialog.getByRole('button', { name: '检查生成方案' }).click()
  await plan.getByRole('button', { name: '确认用量并提交' }).click()
  await expect
    .poll(
      async () => (await read()).jobs.find((j) => j.kind === 'speech')?.state,
      { timeout: 30000 },
    )
    .toBe('ready')
  await expect(dialog.locator('audio')).toBeVisible()
  await dialog
    .locator('article')
    .filter({ has: page.locator('audio') })
    .getByRole('button', { name: '采用并保存新版本' })
    .click()
  await expect.poll(async () => (await read()).asset.voice).toBe('b')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  const projectResponse = await page.request.post('/api/studio/projects', {
    headers,
    data: { title: '批量闭环', requestKey: crypto.randomUUID() },
  })
  const project = await projectResponse.json(),
    path = '/api/studio/projects/' + project.id
  const document = {
    script: '两个镜头',
    assets: [],
    shots: [
      { ...newShot(), id: 'normal', action: '列车驶来' },
      { ...newShot(), id: 'cancel', action: '等待取消' },
    ],
    music: null,
    musicVolume: 1,
  }
  expect(
    (
      await page.request.put(path, { headers, data: { revision: 1, document } })
    ).ok(),
  ).toBeTruthy()
  const current = async (): Promise<StudioProject> =>
    (await page.request.get(path, { headers })).json()
  await page.goto('/#/entertainment/' + project.id + '?section=production')
  await page.getByRole('button', { name: '检查本次制作' }).click()
  await expect(plan.getByText('本次提交', { exact: true })).toHaveCount(2)
  const shotPoints = document.shots.reduce(
    (sum, shot) => sum + Math.ceil(shot.duration / 1000) * 20,
    0,
  )
  await expect(plan.getByText(`本次上限 ${shotPoints} 点`)).toBeVisible()
  expect((await current()).jobs).toHaveLength(0)
  await plan.getByRole('button', { name: '确认用量并提交' }).click()
  await expect
    .poll(
      async () =>
        (await current()).jobs.find((j) => j.subject === 'normal')?.state,
      { timeout: 30000 },
    )
    .toBe('ready')
  await expect
    .poll(
      async () =>
        (await current()).jobs.find((j) => j.subject === 'cancel')?.state,
      { timeout: 30000 },
    )
    .toBe('polling')
  await page
    .locator('article')
    .filter({ hasText: '等待取消' })
    .getByRole('button', { name: '取消任务', exact: true })
    .click()
  await page.getByRole('button', { name: '确认取消', exact: true }).click()
  await expect
    .poll(
      async () =>
        (await current()).jobs.find((j) => j.subject === 'cancel')?.state,
    )
    .toBe('cancelled')
  await page.getByRole('button', { name: '检查本次制作' }).click()
  await plan
    .locator('summary')
    .filter({ hasText: '已跳过，不重复生成' })
    .click()
  await expect(plan.getByText('已有候选，跳过')).toBeVisible()
  await expect(plan.getByText('本次提交', { exact: true })).toHaveCount(1)
  await plan.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByText('只重做失败项', { exact: true }).click()
  await page.getByRole('button', { name: '检查本次制作' }).click()
  await expect(
    plan.getByRole('button', { name: '确认用量并提交' }),
  ).toBeDisabled()
  await plan.getByRole('button', { name: '取消', exact: true }).click()
  for (const theme of ['light', 'dark']) {
    await page.evaluate(
      (theme) =>
        window.document.documentElement.classList.toggle(
          'dark',
          theme === 'dark',
        ),
      theme,
    )
    for (const width of [390, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: 950 })
      await expect(
        page.getByRole('button', { name: '检查本次制作' }),
      ).toBeVisible()
      expect(
        await page.evaluate(
          () => window.document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      ).toBeTruthy()
      await page.screenshot({
        path:
          process.env.WEB_ADMIN_VALIDATION_DIR +
          '/production-' +
          theme +
          '-' +
          width +
          '.png',
        fullPage: true,
      })
    }
  }
  expect(errors).toEqual([])
})
