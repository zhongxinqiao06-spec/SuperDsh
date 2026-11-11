import { expect, test } from '@playwright/test'
import { installFoundationFixture } from './foundation-fixture'

/** 浏览器真实排版与 SVG/公式渲染；公开快照为合成数据，不代替后端集成证据。 */
test('公开分享渲染表格、公式与 Mermaid，主动 HTML 不执行', async ({
  page,
}, info) => {
  const external: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('external.invalid')) external.push(request.url())
  })
  await page.route('**/api/public/shares/synthetic-richtext', (route) =>
    route.fulfill({
      json: {
        session: { id: 'synthetic-session', title: '富文本分享验证' },
        timeline: {
          items: [
            {
              id: 'message',
              type: 'message',
              role: 'assistant',
              content: {
                text: '# 结果\n\n| 名称 | 数值 |\n| --- | --- |\n| 收入 | 12 |\n\n计算：$x^2+y^2$\n\n```mermaid\ngraph TD\nA[方案] --> B[确认]\n```\n\n<img src="https://external.invalid/image" onerror="window.xss=true">\n\n[恶意](javascript:alert%281%29)',
              },
            },
          ],
          hasMore: false,
          nextSeq: null,
        },
      },
    }),
  )
  await page.goto('/#/share/synthetic-richtext')
  await expect(
    page.getByRole('heading', { name: '富文本分享验证' }),
  ).toBeVisible()
  await expect(page.locator('.markdown-content table')).toContainText('收入')
  await expect(page.locator('.katex').first()).toBeVisible()
  await expect(page.locator('.mermaid-diagram svg')).toBeVisible()
  await expect(page.locator('.mermaid-diagram')).toContainText('方案')
  expect(
    await page
      .locator(
        '.markdown-content img, .markdown-content script, .markdown-content a[href^="javascript:"]',
      )
      .count(),
  ).toBe(0)
  expect(external).toEqual([])
  await page.screenshot({
    path: info.outputPath('richtext.png'),
    fullPage: true,
  })
})

test('工作台等待审批可中断，方案冲突保稿，来源和诊断草稿有实际入口', async ({
  page,
}) => {
  const fixture = await installFoundationFixture(page, [
    'sessions.read',
    'sessions.run',
    'models.use',
    'files.read',
    'files.write',
    'devices.manage',
  ])
  fixture.agentStatus = 'running'
  let status = 'waiting_approval',
    conflict = true
  let releaseSend!: () => void
  const sending = new Promise<void>((resolve) => {
    releaseSend = resolve
  })
  let plan = {
    id: 'plan',
    version: 1,
    title: '通用工具方案',
    state: 'prepared',
    summary: '待确认',
    document: { title: '待确认方案' },
  }
  const source = {
    id: 'source',
    sourceId: 'source-stable',
    filename: '资料.txt',
    content: '经过验证的资料原文',
    sha256: 'synthetic-hash',
    location: {},
  }
  await page.route('**/api/sessions/s/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    const json = (value: unknown, code = 200) =>
      route.fulfill({ json: value, status: code })
    if (path.endsWith('/snapshot'))
      return json({
        session: {
          id: 's',
          connectorId: 'connector',
          projectId: null,
          runtimeId: 'dsh',
          runtime: 'dsh',
          title: '审批与方案验证',
          cwd: '',
          status,
          pinned: false,
          archived: false,
          takeover: true,
          unread: false,
          updatedSeq: 0,
          agentDefinition: null,
        },
        state: { status },
        timeline: { items: [], nextSeq: null, hasMore: false },
        notices: [],
        approvals: [],
        effectiveCapabilities: {},
        eventCursor: 'seq:0',
      })
    if (path.endsWith('/plans/plan')) {
      if (conflict)
        return json(
          { detail: '方案已被另一页面修改', code: 'revision_conflict' },
          409,
        )
      const body = route.request().postDataJSON() as {
        document: { title: string }
      }
      plan = { ...plan, version: 2, document: body.document }
      return json({ plan, note: '旧确认已失效，请重新确认方案' })
    }
    if (path.endsWith('/plans')) return json({ items: [plan] })
    if (path.endsWith('/evidence/source')) return json({ source })
    if (path.endsWith('/evidence'))
      return json({
        items: [source],
        answerVerification: {
          status: 'valid',
          message: '引用已复核',
          issues: [],
        },
      })
    if (path.endsWith('/skill-runs')) return json({ items: [] })
    if (path.endsWith('/agent-artifacts'))
      return json({
        items: [
          {
            id: 'draft',
            name: '诊断成果.docx',
            mediaType: 'application/octet-stream',
            sha256: 'synthetic',
            deliverable: false,
            renderedQuality: { status: 'draft' },
          },
        ],
      })
    if (path.endsWith('/runtime/interrupt')) {
      status = 'idle'
      return json({ ok: true })
    }
    if (path.endsWith('/runtime/messages')) {
      await sending
      return json({ detail: '受控发送失败，保留草稿' }, 503)
    }
    if (path.endsWith('/meta')) return json({})
    return json({ detail: '受控测试不建立真实引擎连接' }, 503)
  })
  await page.goto('/#/login')
  await page.getByLabel('用户名或邮箱').fill('admin')
  await page.getByLabel('密码', { exact: true }).fill('Synthetic-password!')
  await page.getByRole('button', { name: '登录 ↵', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: '总览', exact: true }),
  ).toBeVisible()
  await page.goto('/#/workspace/session/s')
  await expect(
    page.getByRole('heading', { name: '审批与方案验证' }),
  ).toBeVisible()
  await expect(page.getByLabel('任务草稿')).toBeDisabled()
  await expect(page.getByRole('button', { name: '中断任务' })).toBeVisible()
  await expect(
    page.getByText('草稿，质量检查未通过', { exact: true }),
  ).toBeVisible()
  await page.locator('summary').filter({ hasText: '通用工具方案' }).click()
  await page.getByRole('button', { name: '修改方案', exact: true }).click()
  const editor = page.getByRole('dialog', { name: '修改方案', exact: true })
  const document = '{"title":"冲突后保留的修订"}'
  await editor.getByLabel('结构化方案').fill(document)
  await editor.getByRole('button', { name: '保存修订' }).click()
  await expect(editor.getByText('方案已被另一页面修改')).toBeVisible()
  await expect(editor.getByLabel('结构化方案')).toHaveValue(document)
  conflict = false
  await editor.getByRole('button', { name: '保存修订' }).click()
  await expect(editor).not.toBeVisible()
  await expect(page.getByText('旧确认已失效，请重新确认方案')).toBeVisible()
  await page
    .locator('summary')
    .filter({ hasText: '资料依据与引用校验' })
    .click()
  await page.getByRole('button', { name: '资料.txt · source-stable' }).click()
  const evidence = page.getByRole('dialog', { name: '资料.txt', exact: true })
  await expect(evidence.getByText('经过验证的资料原文')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(evidence).not.toBeVisible()
  await page.getByRole('button', { name: '中断任务' }).click()
  await expect(page.getByLabel('任务草稿')).toBeEnabled()
  await page.getByLabel('任务草稿').fill('失败后还在的草稿')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  try {
    await expect(page.getByText('发送中…', { exact: true })).toBeVisible()
    await expect(page.getByLabel('会话消息')).toContainText('失败后还在的草稿')
  } finally {
    releaseSend()
  }
  await expect(page.getByText('受控发送失败，保留草稿')).toBeVisible()
  await expect(page.getByLabel('任务草稿')).toHaveValue('失败后还在的草稿')
  await expect(page.getByText('发送中…', { exact: true })).not.toBeVisible()
})
