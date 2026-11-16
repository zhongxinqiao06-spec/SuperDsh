import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { pythonExecutable } from '../../scripts/python-environment.ts'

/** 独立 FastAPI + PostgreSQL + DSH，正式界面上传资料和确认，核实工具生成的可编辑文件。 */
test('办公首页从销售 CSV 到可追溯 Word 简报和 PDF 预览', async ({
  page,
  request,
}) => {
  test.skip(
    process.env.WEB_ADMIN_OFFICE_DELIVERY_LIVE !== '1',
    '由 tests/tooling/office-delivery.ts 提供临时库与只监听回环的模型',
  )
  test.setTimeout(360000)
  const filename = '第三季度经营简报.docx',
    sourceName = 'sales-example.csv'
  const sample = await request.get('/images/website/' + sourceName)
  expect(sample.status()).toBe(200)
  const csv = await sample.body()
  const hash = (value: Buffer) =>
    createHash('sha256').update(value).digest('hex')
  await page.goto('/#/login?returnTo=%2Foffice')
  await page
    .getByLabel('用户名或邮箱')
    .fill(process.env.WEB_ADMIN_E2E_USERNAME ?? 'foundation-admin')
  await page
    .getByLabel('密码', { exact: true })
    .fill(process.env.WEB_ADMIN_E2E_PASSWORD!)
  const login = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/auth/login',
  )
  await page.getByRole('button', { name: '登录 ↵', exact: true }).click()
  const headers = {
    authorization: 'Bearer ' + (await (await login).json()).accessToken,
  }
  const catalog = await request.get(
    '/api/admin/agents/catalog?product=office',
    { headers },
  )
  expect(catalog.status()).toBe(200)
  const tools: { id: string; logicalId: string }[] = (await catalog.json())
    .tools
  const word = tools.find((x) => x.logicalId === 'document_report')
  expect(word, '办公工具未初始化').toBeDefined()
  const agentName = '来源核对验收'
  const setup = await request.post('/api/admin/agents?product=office', {
    headers,
    data: {
      name: agentName,
      instructions:
        '先读取当前会话上传的销售 CSV，再按月计算销售额，生成有资料来源的经营简报。',
      published: true,
      toolIds: [word!.id],
      skillIds: [],
      skillPolicy: { mode: 'legacy' },
    },
  })
  expect(setup.status(), await setup.text()).toBe(201)
  await page.reload()
  await page.locator('.composer-agent-select .el-select__wrapper').click()
  await page.getByRole('option', { name: agentName, exact: true }).click()
  await page
    .getByLabel('添加附件', { exact: true })
    .setInputFiles({ name: sourceName, mimeType: 'text/csv', buffer: csv })
  await page
    .getByRole('textbox', { name: '任务草稿' })
    .fill('请核对上传的销售样表，按月汇总，并生成含来源的可编辑季度经营简报。')
  const create = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/sessions/create-and-start',
    // 引擎首次启动允许等待三分钟，测试还要计入上传与创建会话响应。
    { timeout: 200000 },
  )
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const created = await create.catch(async (error: unknown) => {
    console.log(
      '首页发送诊断',
      (await page.locator('body').innerText()).slice(-1300),
    )
    throw error
  })
  expect(created.ok(), await created.text()).toBe(true)
  const id = (await created.json()).session.id as string
  await expect(page).toHaveURL(new RegExp('/workspace/session/' + id + '$'))
  const conversation = page.url()
  try {
    const confirm = page.getByRole('radio', { name: '确认执行', exact: true })
    await expect(confirm).toBeVisible({ timeout: 45000 })
    await confirm.press('Space')
    await expect(confirm).toBeChecked()
    await page.getByRole('button', { name: '提交回复', exact: true }).click()
    const listing = async () => {
      const response = await request.get(
        '/api/sessions/' + id + '/agent-artifacts',
        { headers },
      )
      expect(response.status()).toBe(200)
      return (await response.json()).items as {
        name: string
        sha256: string
        deliverable: boolean
        renderedQuality: {
          status: string
          issues: unknown[]
        }
        sources: { kind: string; name: string; sha256: string }[]
      }[]
    }
    await expect
      .poll(async () => (await listing()).map((x) => x.name), {
        timeout: 100000,
        intervals: [500, 1500],
      })
      .toContain(filename)
    const result = (await listing()).find((x) => x.name === filename)!
    expect(result.deliverable, JSON.stringify(result.renderedQuality)).toBe(
      true,
    )
    expect(result.renderedQuality.status).toBe('passed')
    expect(result.sources).toContainEqual(
      expect.objectContaining({
        kind: 'attachment',
        name: sourceName,
        sha256: hash(csv),
      }),
    )
    await page.goto('/#/office')
    const feature = page.getByRole('region', { name: '最近交付' })
    const preview = page.waitForResponse((r) =>
      /agent-artifacts\/[^/]+\/preview$/.test(new URL(r.url()).pathname),
    )
    await feature
      .getByRole('button', { name: '预览 ' + filename, exact: true })
      .click()
    const payload = await (await preview).json()
    expect(payload.mediaType).toBe('application/pdf')
    expect(
      Buffer.from(payload.contentBase64, 'base64').subarray(0, 5).toString(),
    ).toBe('%PDF-')
    const dialog = page.getByRole('dialog', { name: filename, exact: true })
    await expect(dialog.locator('iframe')).toBeVisible()
    await dialog.getByRole('button', { name: '关闭此对话框' }).click()
    const downloaded = page.waitForEvent('download')
    await feature
      .getByRole('button', { name: '下载 ' + filename, exact: true })
      .click()
    const file = await downloaded
    expect(file.suggestedFilename()).toBe(filename)
    const path = (await file.path())!
    expect(hash(await readFile(path))).toBe(result.sha256)
    // DOCX 不能只看扩展名，直接解包并从可编辑正文和表格复核金额与引用文件。
    const paragraphs = execFileSync(
      pythonExecutable(),
      [
        '-c',
        'import json,sys,zipfile; from xml.etree import ElementTree as E; z=zipfile.ZipFile(sys.argv[1]); root=E.fromstring(z.read("word/document.xml")); print(json.dumps([p.text for p in root.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t")]))',
        path,
      ],
      { encoding: 'utf8' },
    )
    const content = (JSON.parse(paragraphs) as string[]).join(' ')
    for (const expected of ['128.6', '38.6', '41.6', '48.4', sourceName])
      expect(content).toContain(expected)
    // 使用真实会话地址重新登录，历史会话及已生成的成果必须仍然可读。
    expect(
      (
        await page.request.post('/api/auth/logout', {
          headers: { Origin: new URL(conversation).origin },
          data: {},
        })
      ).status(),
    ).toBe(204)
    await page.goto('about:blank')
    await page.goto(conversation)
    await page
      .getByLabel('用户名或邮箱')
      .fill(process.env.WEB_ADMIN_E2E_USERNAME ?? 'foundation-admin')
    await page
      .getByLabel('密码', { exact: true })
      .fill(process.env.WEB_ADMIN_E2E_PASSWORD!)
    await page.getByRole('button', { name: '登录 ↵', exact: true }).click()
    await expect(page).toHaveURL(conversation)
    await expect(
      page.getByText(filename, { exact: false }).first(),
    ).toBeVisible()
    console.log(
      '办公真链路通过：公开 CSV 来源摘要相符；Word 正文 128.6 万元，月度金额 38.6、41.6、48.4；首页 PDF 预览与 DOCX 下载通过。',
    )
  } catch (error) {
    console.error(
      '办公会话诊断',
      (
        await page
          .locator('main')
          .innerText()
          .catch(() => page.locator('body').innerText())
      ).slice(-1800),
    )
    throw error
  }
})
