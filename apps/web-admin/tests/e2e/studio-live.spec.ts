import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pythonExecutable } from '../../scripts/python-environment.ts'
import { newShot } from '../../fronted/src/utils/studio/storyboard'
import type { StudioProject } from '../../fronted/src/types/studio/studio'

/** 独立数据库中的真实登录、产品授权、工程保存和办公回链。 */
test('真实账号切换产品并重新打开作品', async ({ page }) => {
  test.setTimeout(90_000)
  test.skip(process.env.WEB_ADMIN_E2E_LIVE !== '1', '需要隔离后端')
  const title = '雨夜站台 ' + Date.now()
  await page.goto('/#/login')
  await page
    .getByLabel('用户名或邮箱')
    .fill(process.env.WEB_ADMIN_E2E_USERNAME ?? 'foundation-admin')
  await page
    .getByLabel('密码', { exact: true })
    .fill(process.env.WEB_ADMIN_E2E_PASSWORD!)
  await page.getByRole('button', { name: '登录 ↵', exact: true }).click()
  await page.getByRole('link', { name: /星桥娱乐/ }).click()

  await page.getByRole('link', { name: '分镜创作', exact: true }).click()
  await page
    .getByRole('region', { name: '新建分镜作品', exact: true })
    .getByLabel('作品名称', { exact: true })
    .fill(title)
  await page.getByRole('button', { name: '创建并编辑故事' }).click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
  await page.getByLabel('剧本正文').fill('小林和小禾在雨夜车站重逢。')
  await page.getByRole('button', { name: '保存工程' }).click()
  await expect(
    page.getByRole('status').filter({ hasText: '已自动保存' }),
  ).toBeVisible()
  await page.getByRole('link', { name: '返回我的作品' }).click()
  await page.getByRole('link', { name: new RegExp(title) }).click()
  await page
    .getByRole('navigation', { name: '作品工作区' })
    .getByRole('link', { name: '剧本与场次' })
    .click()
  await expect(page.getByLabel('剧本正文')).toHaveValue(
    '小林和小禾在雨夜车站重逢。',
  )
  const sidebar = page.getByRole('navigation', { name: '平台导航' })
  await sidebar.getByRole('button', { name: '素材中心', exact: true }).click()
  await sidebar.getByRole('link', { name: '角色库', exact: true }).click()
  await page.getByRole('button', { name: '新增个人素材' }).click()
  const editor = page.getByRole('dialog')
  await editor.getByLabel('素材名称').fill('小林 · 雨衣')
  await editor.getByLabel('设定说明').fill('身穿深绿色雨衣')
  await editor.getByRole('button', { name: '保存', exact: true }).click()
  await page
    .getByRole('row', { name: /小林 · 雨衣/ })
    .getByRole('button', { name: '引用到作品' })
    .click()
  await editor.getByRole('radio', { name: title, exact: true }).check()
  await editor.getByRole('button', { name: '引用此版本' }).click()
  await expect(editor).toBeHidden()
  await page.getByText('个人素材', { exact: true }).first().click()
  await page.getByRole('option', { name: '作品素材' }).click()
  await page
    .getByRole('row', { name: /小林 · 雨衣/ })
    .getByRole('link', { name: '作品素材' })
    .click()
  await expect(page).toHaveURL(/section=library$/)
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
  await sidebar.getByRole('link', { name: '制作任务', exact: true }).click()
  await expect(page.getByText(/暂无制作任务/)).toBeVisible()
  await page.getByRole('link', { name: '切换产品' }).click()
  await page.getByRole('link', { name: /星桥办公/ }).click()
  await page.getByRole('link', { name: /办公工作台/ }).click()
  await expect(page).toHaveURL(/#\/workspace$/)
})

test('真实三镜剪辑切换雨夜候选，刷新保留第三镜的台词音轨及开头裁剪', async ({
  page,
}, info) => {
  test.setTimeout(90000)
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
  const title = '三镜 · 雨夜 ' + Date.now()
  const created = await page.request.post('/api/studio/projects', {
    headers,
    data: { title },
  })
  expect(created.ok()).toBeTruthy()
  const project = (await created.json()).id as string
  const path = '/api/studio/projects/' + project
  const role = (
    await (
      await page.request.post('/api/studio/assets', {
        headers,
        data: {
          kind: 'character',
          name: '小林',
          description: '深绿色雨衣',
          voice: '小林原声',
          project,
        },
      })
    ).json()
  ).id as string
  const [before, after, audio] = execFileSync(
    pythonExecutable(),
    [resolve('apps/web-admin/tests/fixtures/studio_browser_media.py'), project],
    { encoding: 'utf8', windowsHide: true },
  )
    .trim()
    .split(' ')
  const opening = { ...newShot(), action: '站台远景', trimEnd: 1500 },
    middle = { ...newShot(), action: '列车靠站' },
    third = {
      ...newShot(),
      id: 'platform',
      action: '第三镜望向月台',
      scene: '车站',
      duration: 2000,
      candidate: before,
      references: [role],
      lines: [
        {
          id: 'platform-line',
          role,
          text: '车来了。',
          voice: '小林原声',
          subtitle: '车来了。',
          start: 0,
          end: 1500,
          audio,
          volume: 1,
        },
      ],
    }
  const saved = await page.request.put(path, {
    headers,
    data: {
      revision: 1,
      document: { assets: [role], shots: [opening, middle, third] },
    },
  })
  expect(saved.ok(), await saved.text()).toBeTruthy()
  await page.goto(
    '/#/entertainment/' + project + '?section=storyboard&shot=platform',
  )
  const monitor = page.getByRole('region', { name: '镜头预览与候选' })
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
  await monitor.getByRole('button', { name: /候选 2/ }).click()
  await monitor.getByRole('button', { name: '对比候选' }).click()
  const streams = monitor.locator('video[controls]')
  await expect(streams).toHaveCount(2)
  await expect
    .poll(() =>
      streams.evaluateAll((nodes) =>
        nodes.every(
          (n) =>
            n instanceof HTMLVideoElement &&
            n.videoWidth === 192 &&
            n.duration > 1,
        ),
      ),
    )
    .toBe(true)
  const read = async (): Promise<StudioProject> =>
    await (await page.request.get(path, { headers })).json()
  expect((await read()).document.shots[2]?.candidate).toBe(before)
  await page.screenshot({ path: info.outputPath('studio-board.png') })
  await monitor.getByRole('button', { name: '采用到时间线' }).click()
  await expect
    .poll(async () => (await read()).document.shots[2]?.candidate)
    .toBe(after)
  await page.reload()
  await expect(
    monitor.getByRole('button', { name: '时间线已采用' }),
  ).toBeDisabled()
  await page.getByRole('link', { name: '进入时间线' }).click()
  await expect(page.locator('.timeline-picture video')).toHaveAttribute(
    'src',
    new RegExp(after + '$'),
  )
  await page.screenshot({ path: info.outputPath('studio-timeline.png') })
  await page.getByRole('link', { name: '返回分镜板' }).click()
  await monitor.getByRole('button', { name: /候选 1/ }).click()
  await monitor.getByRole('button', { name: '采用到时间线' }).click()
  await expect
    .poll(async () => (await read()).document.shots[2]?.candidate)
    .toBe(before)
  const final = await read()
  expect(final.revision).toBe(4)
  expect(final.document.shots[0]?.trimEnd).toBe(1500)
  expect(final.document.shots[2]?.lines).toEqual(
    third.lines.map((l) => ({ ...l, subtitleStart: null })),
  )
  expect(final.document.shots[2]?.references).toEqual([role])
  await page.getByRole('link', { name: '返回我的作品' }).click()
  await expect(
    page.getByRole('link', { name: title, exact: true }).locator('video'),
  ).toHaveAttribute('src', new RegExp(before + '$'))
  await page
    .getByRole('navigation', { name: '平台导航' })
    .getByRole('button', { name: '素材中心', exact: true })
    .click()
  await page
    .getByRole('navigation', { name: '平台导航' })
    .getByRole('link', { name: '角色库', exact: true })
    .click()
  await page.getByText('个人素材', { exact: true }).first().click()
  await page.getByRole('option', { name: '作品素材' }).click()
  await page
    .getByRole('row', { name: new RegExp('小林.*' + title) })
    .getByRole('button', { name: '查看素材' })
    .click()
  const usage = page.getByRole('region', { name: '素材使用位置' })
  await expect(usage).toContainText(title)
  await usage.getByRole('link', { name: '镜 3', exact: true }).click()
  await expect(page).toHaveURL(/section=storyboard&shot=platform/)
  // 作品链接可在无登录态的新窗口恢复同一修订中的镜头。
  const destination = page.url()
  const origin = new URL(destination).origin
  expect(
    (
      await page.request.post('/api/auth/logout', {
        headers: { Origin: origin },
        data: {},
      })
    ).status(),
  ).toBe(204)
  await page.goto('about:blank')
  await page.goto(destination)
  await page
    .getByLabel('用户名或邮箱')
    .fill(process.env.WEB_ADMIN_E2E_USERNAME ?? 'foundation-admin')
  await page
    .getByLabel('密码', { exact: true })
    .fill(process.env.WEB_ADMIN_E2E_PASSWORD!)
  await page.getByRole('button', { name: '登录 ↵', exact: true }).click()
  await expect(page).toHaveURL(destination)
  await expect(
    monitor.getByRole('button', { name: '时间线已采用' }),
  ).toBeDisabled()
})
