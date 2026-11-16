import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { resolve, relative, isAbsolute } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { pythonExecutable } from '../../scripts/python-environment'
import type { StudioProject } from '../../fronted/src/types/studio/studio'

/** 真实保存/关联/采用/撤回接口，模型调用用隔离 DSH 工具回执代替。 */
test('选段及单场 AI 修改，刷新恢复建议，采用撤回并恢复短暂 502', async ({
  page,
}) => {
  test.setTimeout(180000)
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
    { timeout: 60000 },
  )
  await page.getByRole('button', { name: '登录 ↵', exact: true }).click()
  const token = (await (await signed).json()).accessToken
  const headers = { authorization: 'Bearer ' + token }
  const created = await page.request.post('/api/studio/projects', {
    headers,
    data: { title: '局部改写验收' },
  })
  const id = (await created.json()).id
  const path = '/api/studio/projects/' + id
  const read = async (): Promise<StudioProject> =>
    (await page.request.get(path, { headers })).json()
  let coldStart = true
  await page.route('**' + path, (route) => {
    if (coldStart && route.request().method() === 'GET') {
      coldStart = false
      return route.fulfill({
        status: 502,
        json: { detail: 'synthetic cold start' },
      })
    }
    return route.continue()
  })
  await page.goto('/#/entertainment/' + id + '?section=script')
  await expect(page.getByLabel('剧本正文')).toBeVisible({ timeout: 12000 })
  const script = '开头。\n噜噜说：你好，海南。\n结尾。'
  await page.getByLabel('剧本正文').fill(script)
  await expect.poll(async () => (await read()).document.script).toBe(script)
  await page.getByLabel('剧本正文').evaluate((node) => {
    const input = node as HTMLTextAreaElement
    input.setSelectionRange(4, 14)
    input.dispatchEvent(new Event('select', { bubbles: true }))
  })
  await page
    .getByRole('button', { name: '选中文字建一场', exact: true })
    .click()
  await expect(page.getByLabel('本场正文', { exact: true })).toHaveValue(
    '噜噜说：你好，海南。',
  )
  await expect
    .poll(async () => (await read()).document.scenes?.[0]?.scriptRange?.start)
    .toBe(4)
  // 只替换引擎启动/传输，作品会话仍由真实接口创建，范围记录与工具入库均走正式实现。
  await page.route('**/conversation/runtime?purpose=text-edit', (route) =>
    route.fulfill({ json: { agent: { status: 'running' } } }),
  )
  let editId = ''
  await page.route('**/runtime/messages', async (route) => {
    const data = route.request().postDataJSON()
    editId = data.clientMessageId.replace('text-edit-', '')
    return route.fulfill({ json: { accepted: true } })
  })
  await page.getByRole('button', { name: 'AI 修改本场', exact: true }).click()
  const panel = page.getByRole('dialog', { name: 'AI 剧本编辑' })
  await panel.getByRole('button', { name: '润色表达', exact: true }).click()
  await panel.getByRole('button', { name: '生成修改建议' }).click()
  await expect.poll(() => editId).not.toBe('')
  execFileSync(
    pythonExecutable(),
    [
      '-B',
      resolve('apps/web-admin/tests/tooling/complete_text_edit.py'),
      id,
      editId,
    ],
    {
      env: { ...process.env, SCRIPT_EDIT_TEST_TOKEN: token },
      windowsHide: true,
      encoding: 'utf8',
    },
  )
  await expect(panel.getByLabel('修改建议', { exact: true })).toHaveValue(
    '噜噜说：海风真舒服，我们一起去看海。',
  )
  await page.reload()
  await page.getByRole('button', { name: 'AI 修改记录', exact: true }).click()
  await panel
    .getByRole('button', { name: /润色表达，保留原意.*待采用/ })
    .click()
  const capture = process.env.WEB_ADMIN_DESIGN_CAPTURE_DIR
  if (capture) {
    const checked = relative(
      resolve('.superdsh-work/web-admin-validation'),
      resolve(capture),
    )
    if (!checked || checked.startsWith('..') || isAbsolute(checked))
      throw new Error('截图路径必须隔离')
    await mkdir(capture, { recursive: true })
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (value) => localStorage.setItem('starbridge.theme', value),
        theme,
      )
      await page.reload()
      await page
        .getByRole('button', { name: 'AI 修改记录', exact: true })
        .click()
      await panel
        .getByRole('button', { name: /润色表达，保留原意.*待采用/ })
        .click()
      for (const width of [390, 768, 1280, 1440]) {
        await page.setViewportSize({ width, height: 960 })
        await expect(
          panel.getByRole('button', { name: '采用并保存', exact: true }),
        ).toBeVisible()
        await expect
          .poll(() =>
            panel.evaluate((node) => {
              const box = node.getBoundingClientRect()
              return (
                box.left >= 0 &&
                box.right <= innerWidth + 1 &&
                node.scrollWidth <= node.clientWidth + 1
              )
            }),
          )
          .toBe(true)
        await page.screenshot({
          path: resolve(capture, `script-ai-compare-${theme}-${width}.png`),
          animations: 'disabled',
        })
      }
    }
    await page.evaluate(() => localStorage.setItem('starbridge.theme', 'light'))
    await page.reload()
    await page.getByRole('button', { name: 'AI 修改记录', exact: true }).click()
    await panel
      .getByRole('button', { name: /润色表达，保留原意.*待采用/ })
      .click()
  }
  const candidate = '噜噜说：海风真舒服，我们一起去看海。'
  await panel.getByLabel('修改建议', { exact: true }).fill(candidate + '走吧！')
  await panel.getByRole('button', { name: '关闭此对话框' }).click()
  await page.getByRole('button', { name: 'AI 修改记录', exact: true }).click()
  await expect(panel.getByLabel('修改建议', { exact: true })).toHaveValue(
    candidate + '走吧！',
  )
  await panel.getByRole('button', { name: '采用并保存', exact: true }).click()
  await expect
    .poll(async () => (await read()).document.script)
    .toContain(candidate + '走吧！')
  await expect(
    panel.getByText('已采用并保存。关联分镜请核对，现有视频和配音均已保留。'),
  ).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: 'AI 修改记录', exact: true }).click()
  await panel
    .getByRole('button', { name: /润色表达，保留原意.*已采用/ })
    .click()
  await expect(panel.getByLabel('修改建议', { exact: true })).toHaveValue(
    candidate + '走吧！',
  )
  await panel.getByRole('button', { name: '撤回本次采用', exact: true }).click()
  await expect.poll(async () => (await read()).document.script).toBe(script)
  await panel.getByRole('button', { name: '关闭此对话框' }).click()
  await page.getByLabel('剧本正文').evaluate((node) => {
    const input = node as HTMLTextAreaElement
    input.setSelectionRange(0, 3)
    input.dispatchEvent(new Event('select', { bubbles: true }))
  })
  await page.getByRole('button', { name: 'AI 修改选段', exact: true }).click()
  await expect(
    panel.getByText('只修改选定的 3 字，采用前正文保持不变。'),
  ).toBeVisible()
  await panel.getByRole('button', { name: '关闭此对话框' }).click()
  let failing = true
  await page.route('**/api/studio/projects/' + id, (route) =>
    failing && route.request().method() === 'GET'
      ? route.fulfill({
          status: 502,
          json: { detail: 'synthetic temporary gateway failure' },
        })
      : route.continue(),
  )
  await expect(page.getByText(/连接暂时中断，正在重连/)).toBeVisible({
    timeout: 12000,
  })
  failing = false
  await expect(page.getByText(/连接暂时中断，正在重连/)).toHaveCount(0, {
    timeout: 12000,
  })
  await expect(page.getByLabel('剧本正文')).toHaveValue(script)
  if (capture) {
    for (const width of [390, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: 960 })
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        )
        .toBe(true)
      await page.screenshot({
        path: resolve(capture, 'script-ai-' + width + '.png'),
      })
    }
  }
})
