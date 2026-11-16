import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pythonExecutable } from '../../scripts/python-environment.ts'
import { newShot } from '../../fronted/src/utils/studio/storyboard'
import type { StudioProject } from '../../fronted/src/types/studio/studio'

/** 新界面真实 API 闭环：阶段确认、卡片候选采用、三方草案、分镜预演和试片入口。 */
test('创作准备页面与真实接口对应，采用候选并保留局部编辑', async ({ page }) => {
  test.setTimeout(180_000)
  test.skip(process.env.WEB_ADMIN_E2E_LIVE !== '1', '需要隔离后端')
  await page.goto('/#/login')
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
  await page.getByRole('link', { name: /星桥娱乐/ }).click()
  await page.getByRole('button', { name: '新建作品' }).click()
  const creating = page.getByRole('dialog', { name: '新建作品' })
  await creating
    .getByLabel('作品名称', { exact: true })
    .fill('雨后站台 · 创作准备')
  await creating
    .getByLabel('故事构想')
    .fill('两人在雨后的站台重逢，决定一起出发')
  await creating.getByLabel('视觉风格').fill('写实空镜，克制的蓝灰与暖光')
  await creating.getByRole('button', { name: '创建并进入' }).click()
  await expect(page.getByLabel('剧本正文')).toBeVisible()
  const id = page.url().match(/entertainment\/([^?]+)/u)![1]!
  const path = '/api/studio/projects/' + id
  const read = async (): Promise<StudioProject> =>
    (await page.request.get(path, { headers })).json()
  await page
    .getByLabel('剧本正文')
    .fill('小林说：我们出发吧。小禾点头，两人走向列车。')
  await expect
    .poll(async () => (await read()).document.script)
    .toContain('我们出发吧')
  await page.getByRole('button', { name: '审阅剧本并继续' }).click()
  const scriptReview = page.getByRole('dialog', { name: '确认本次剧本' })
  await expect(scriptReview.getByLabel('本次确认的剧本')).toContainText(
    '我们出发吧',
  )
  await scriptReview
    .getByRole('button', { name: '确认剧本，进入人物设定' })
    .click()
  await expect(page).toHaveURL(/section=cast/)
  expect(
    (await page.request.get(path + '/preparation', { headers })).ok(),
  ).toBeTruthy()
  await page.getByRole('button', { name: '添加或引用素材' }).first().click()
  const library = page.getByRole('dialog', { name: '项目素材与个人库' })
  await library.getByLabel('名称', { exact: true }).fill('小林')
  await library.getByLabel('外观或设定').fill('蓝外套，短发，清晰轮廓')
  await library.getByRole('button', { name: '保存素材版本' }).click()
  await expect.poll(async () => (await read()).document.assets.length).toBe(1)
  await library.locator('.el-drawer__close-btn').click()
  await expect(
    page.locator('.cast-card').getByRole('heading', { name: '小林' }),
  ).toBeVisible()
  const current = await read(),
    role = current.document.assets[0]!
  const connection = await page.request.post('/api/admin/models/connections', {
    headers,
    data: {
      name: '隔离试听连接',
      adapter: 'openai-completions',
      baseUrl:
        'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      apiKey: 'synthetic',
    },
  })
  expect(connection.ok(), await connection.text()).toBeTruthy()
  const configuration = await page.request.post(
    '/api/admin/models/configurations',
    {
      headers,
      data: {
        name: '双角色试听模型',
        connectionId: (await connection.json()).id,
        capability: 'speech.synthesize',
        modelId: 'synthetic-voice',
        parameters: { voices: 'voice-a,voice-b' },
      },
    },
  )
  expect(configuration.ok(), await configuration.text()).toBeTruthy()
  const model = await configuration.json()
  execFileSync(
    pythonExecutable(),
    [
      resolve('apps/web-admin/tests/fixtures/studio_preparation_media.py'),
      id,
      role,
      model.id,
      String(model.revision),
    ],
    { encoding: 'utf8', windowsHide: true },
  )
  const document = structuredClone(current.document)
  document.shots = [
    {
      ...newShot(),
      id: 'station',
      action: '站台重逢',
      references: [role],
      trimEnd: 4000,
      lines: [
        {
          id: 'hello',
          role,
          text: '我们出发吧。',
          voice: '',
          subtitle: null,
          start: 0,
          end: null,
          audio: null,
          volume: 1,
        },
      ],
    },
  ]
  expect(
    (
      await page.request.put(path, {
        headers,
        data: { revision: current.revision, document },
      })
    ).ok(),
  ).toBeTruthy()
  await page.reload()
  await page.getByRole('button', { name: '试听选音色' }).click()
  const audition = page.getByRole('dialog', { name: '小林 · 试听音色' })
  await audition.getByLabel('试听台词').fill('我们出发吧。')
  await audition.getByRole('button', { name: '检查本次方案' }).click()
  await expect(
    audition.getByRole('heading', { name: '本次制作方案' }),
  ).toBeVisible()
  expect((await read()).jobs).toHaveLength(3)
  await audition.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('button', { name: /查看检查/ }).click()
  await page.getByRole('button', { name: '定位', exact: true }).first().click()
  await expect(
    page.getByRole('dialog', { name: '小林 · 候选与版本' }),
  ).toBeVisible()
  await page
    .getByRole('dialog', { name: '小林 · 候选与版本' })
    .locator('.el-drawer__close-btn')
    .click()
  await page.getByRole('button', { name: '候选与版本' }).click()
  const candidates = page.getByRole('dialog', { name: '小林 · 候选与版本' })
  await expect(candidates.locator('img')).toHaveCount(2)
  expect((await read()).assets.find((a) => a.id === role)?.fileId).toBeNull()
  await candidates.getByRole('button', { name: '采用此画面' }).first().click()
  await expect
    .poll(async () => (await read()).document.assets[0])
    .not.toBe(role)
  await candidates.getByRole('button', { name: '采用此音色' }).click()
  await expect
    .poll(async () => {
      const updated = await read()
      return updated.assets.find((a) => a.id === updated.document.assets[0])
        ?.voice
    })
    .toBe('voice-b')
  await candidates.locator('.el-drawer__close-btn').click()
  const after = await read()
  expect(after.document.shots[0]?.trimEnd).toBe(4000)
  expect(after.document.shots[0]?.lines[0]?.text).toBe('我们出发吧。')
  await page.getByText('我已审阅本阶段内容', { exact: true }).click()
  await page.getByRole('button', { name: '确认设定，进入分镜' }).click()
  await expect(page).toHaveURL(/section=storyboard/)
  const proposed = structuredClone(after.document)
  proposed.shots[0]!.scene = '雨夜站台'
  proposed.shots[0]!.camera = '远景'
  const proposal = await page.request.post(path + '/proposals', {
    headers,
    data: {
      revision: after.revision,
      requestKey: 'browser-proposal',
      document: proposed,
    },
  })
  expect(proposal.ok(), await proposal.text()).toBeTruthy()
  await page.getByLabel('动作摘要').fill('保留我手工编辑的走位')
  await expect
    .poll(async () => (await read()).document.shots[0]?.action)
    .toBe('保留我手工编辑的走位')
  await expect(page.getByRole('heading', { name: '方案对比' })).toBeVisible()
  await page.getByText('镜 1 · 场景', { exact: true }).click()
  await page.getByRole('button', { name: '采用选中字段' }).click()
  await expect
    .poll(async () => (await read()).document.shots[0]?.scene)
    .toBe('雨夜站台')
  expect((await read()).document.shots[0]?.camera).toBe('')
  expect((await read()).document.shots[0]?.action).toBe('保留我手工编辑的走位')
  await page.getByRole('button', { name: '查看分镜预演' }).click()
  await page.getByRole('button', { name: '播放分镜预演' }).click()
  await expect(page.getByRole('button', { name: '暂停预演' })).toBeVisible()
  await page.getByRole('button', { name: '暂停预演' }).click()
  await expect(page.getByRole('region', { name: '分镜预演' })).toContainText(
    '不是正式成片',
  )
  const nav = page.getByRole('navigation', { name: '作品工作区' })
  await nav.getByRole('link', { name: '试做一镜', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: '选一镜验证效果' }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: '添加分镜' })).toHaveCount(0)
  await page.getByRole('button', { name: /查看检查/ }).click()
  await page
    .getByLabel('略过理由', { exact: true })
    .fill('本次先确认静态分镜和声音，视频试做另行安排')
  await page.getByRole('button', { name: '记录理由并跳过试片' }).click()
  await expect(page).toHaveURL(/section=production/)
  expect(
    (
      await (await page.request.get(path + '/preparation', { headers })).json()
    ).stages.find((stage: { key: string }) => stage.key === 'sample').status,
  ).toBe('skipped')
  const directory = resolve(
    '.superdsh-work/web-admin-validation/studio-preparation/screenshots',
  )
  await mkdir(directory, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [390, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: 960 })
      for (const stage of ['角色与场景', '分镜设计', '试做一镜']) {
        await nav.getByRole('link', { name: stage, exact: true }).click()
        await expect(page.locator('.studio-editor')).toBeVisible()
        expect(
          await page.evaluate(
            () => window.document.documentElement.scrollWidth <= innerWidth + 2,
          ),
        ).toBe(true)
      }
      await nav.getByRole('link', { name: '角色与场景', exact: true }).click()
      await page.screenshot({
        path: resolve(directory, `cast-${theme}-${width}.png`),
        fullPage: true,
      })
    }
  }
})
