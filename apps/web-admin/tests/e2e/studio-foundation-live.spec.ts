import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { StudioProject } from '../../fronted/src/types/studio/studio'

/** 真实 Vue/FastAPI/PostgreSQL 流程，无供应商调用；样图和账号均为隔离合成数据。 */
test('新建规格、场次与分镜自动保存，冲突不覆盖草稿，归档恢复', async ({
  page,
}) => {
  test.setTimeout(150_000)
  test.skip(process.env.WEB_ADMIN_E2E_LIVE !== '1', '需要隔离后端')
  await page.goto('/#/login')
  await page
    .getByLabel('用户名或邮箱')
    .fill(process.env.WEB_ADMIN_E2E_USERNAME ?? 'foundation-admin')
  await page
    .getByLabel('密码', { exact: true })
    .fill(process.env.WEB_ADMIN_E2E_PASSWORD!)
  const signed = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/auth/login') &&
      response.request().method() === 'POST',
  )
  await page.getByRole('button', { name: '登录 ↵', exact: true }).click()
  const headers = {
    authorization: 'Bearer ' + (await (await signed).json()).accessToken,
  }
  await page.getByRole('link', { name: /星桥娱乐/ }).click()
  await page.getByRole('button', { name: '新建作品' }).click()
  const dialog = page.getByRole('dialog', { name: '新建作品' })
  await dialog
    .getByLabel('作品名称', { exact: true })
    .fill('雨后站台 · 基础验收')
  await dialog.getByLabel('故事构想').fill('小林与小禾在雨后的站台重逢')
  await dialog.getByLabel('视觉风格').fill('写实雨夜、克制叙事')
  await dialog.getByLabel('目标时长').fill('90')
  await dialog.getByRole('button', { name: '创建并进入' }).click()
  await expect(
    page.getByRole('heading', { name: '雨后站台 · 基础验收', exact: true }),
  ).toBeVisible()
  const id = page.url().match(/entertainment\/([^?]+)/u)![1]!
  const path = '/api/studio/projects/' + id
  const read = async (): Promise<StudioProject> =>
    (await page.request.get(path, { headers })).json()
  expect((await read()).targetDurationMs).toBe(90000)
  await page
    .getByLabel('剧本正文')
    .fill('外景，雨后站台。小林说：你终于来了。小禾说：我们走吧。')
  await page.getByRole('button', { name: '添加场次' }).click()
  await page.getByLabel('场次名称').fill('外景·站台·夜')
  await page.getByLabel('场次摘要').fill('两人重逢后登车')
  await expect
    .poll(async () => (await read()).document.scenes?.[0]?.synopsis)
    .toBe('两人重逢后登车')
  const steps = page.getByRole('navigation', { name: '作品工作区' })
  await expect(steps.getByRole('link')).toHaveCount(8)
  await steps.getByRole('link', { name: '分镜设计', exact: true }).click()
  await page.getByRole('button', { name: '添加分镜' }).click()
  await page.getByLabel('动作摘要').fill('小林站在雨后的站台')
  await page.getByLabel('所属场次').selectOption({ label: '外景·站台·夜' })
  await expect
    .poll(async () => (await read()).document.shots[0]?.action)
    .toBe('小林站在雨后的站台')
  const shotId = (await read()).document.shots[0]!.id
  await page.reload()
  await expect(page.getByLabel('动作摘要')).toHaveValue('小林站在雨后的站台')
  expect((await read()).document.shots[0]!.id).toBe(shotId)
  // 请求在服务端已提交而响应丢失时，重试必须沿用同一个操作号。
  let loseResponse = true
  await page.route('**' + path, async (route) => {
    if (route.request().method() === 'PUT' && loseResponse) {
      loseResponse = false
      await route.fetch()
      await route.abort('failed')
    } else await route.continue()
  })
  const previousRevision = (await read()).revision
  await page.getByLabel('动作摘要').fill('保留已提交的新画面')
  await expect(page.getByRole('alert')).toContainText('保存失败')
  await page.getByRole('button', { name: '保存工程' }).click()
  await expect(
    page.getByRole('status').filter({ hasText: '已自动保存' }),
  ).toBeVisible()
  expect((await read()).revision).toBe(previousRevision + 1)
  await page.unroute('**' + path)
  // 第二个窗口写入后，本地草稿收到冲突，明确载入才放弃草稿。
  const before = await read()
  await page.getByLabel('动作摘要').fill('本地尚未保存的修改')
  const remote = structuredClone(before.document)
  remote.shots[0]!.action = '另一个窗口的画面'
  expect(
    (
      await page.request.put(path, {
        headers,
        data: {
          revision: before.revision,
          requestKey: 'remote-edit',
          document: remote,
        },
      })
    ).ok(),
  ).toBeTruthy()
  await expect(page.getByRole('button', { name: '载入最新工程' })).toBeVisible()
  await expect(page.getByLabel('动作摘要')).toHaveValue('本地尚未保存的修改')
  await page.getByRole('button', { name: '载入最新工程' }).click()
  await page
    .getByRole('dialog', { name: '确认操作' })
    .getByRole('button', { name: '载入最新工程' })
    .click()
  await expect(page.getByLabel('动作摘要')).toHaveValue('另一个窗口的画面')
  const output = resolve(
    '.superdsh-work/web-admin-validation/studio-foundation/screenshots',
  )
  await mkdir(output, { recursive: true })
  for (const width of [390, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 960 })
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      for (const name of ['作品构想', '剧本与场次', '角色与场景', '分镜设计']) {
        await steps.getByRole('link', { name, exact: true }).click()
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true)
      }
      await page.screenshot({
        path: resolve(output, `board-${width}-${colorScheme}.png`),
        fullPage: true,
      })
    }
  }
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.getByRole('link', { name: '作品首页' }).click()
  await page.getByRole('button', { name: '归档作品' }).click()
  await page
    .getByRole('dialog', { name: '归档作品' })
    .getByRole('button', { name: '归档', exact: true })
    .click()
  await expect(
    page.getByRole('link', { name: '雨后站台 · 基础验收', exact: true }),
  ).toHaveCount(0)
  await page.getByRole('combobox', { name: '作品范围' }).focus()
  await page.getByRole('combobox', { name: '作品范围' }).press('ArrowDown')
  await page.getByRole('option', { name: '已归档', exact: true }).click()
  await page.getByRole('button', { name: '恢复作品' }).click()
  await page
    .getByRole('dialog', { name: '恢复作品' })
    .getByRole('button', { name: '恢复', exact: true })
    .click()
  await expect.poll(async () => (await read()).lifecycle).toBe('active')
})
