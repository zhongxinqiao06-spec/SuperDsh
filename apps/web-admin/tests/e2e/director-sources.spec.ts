import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { installFoundationFixture } from './foundation-fixture'
import type { StudioProject } from '../../fronted/src/types/studio/studio'

const capture = resolve(
  process.env.WEB_ADMIN_VALIDATION_DIR ??
    '.superdsh-work/web-admin-validation/lulu-workflow/director-layout',
  'screens',
)

/** 正文滚动不会把字段藏在操作栏下；手机按钮与标题始终保留在可见区域。 */
async function inspectDrawer(page: Page, panel: Locator) {
  await expect
    .poll(() =>
      panel.evaluate((node) => {
        const box = node.getBoundingClientRect()
        const header = node
          .querySelector('.el-drawer__header')!
          .getBoundingClientRect()
        const body = node.querySelector('.el-drawer__body')!
        const bodyBox = body.getBoundingClientRect()
        const footer = node
          .querySelector('.el-drawer__footer')!
          .getBoundingClientRect()
        return (
          box.left >= 0 &&
          box.right <= innerWidth + 1 &&
          node.scrollWidth <= node.clientWidth + 1 &&
          body.scrollWidth <= body.clientWidth + 1 &&
          header.bottom <= bodyBox.top + 1 &&
          bodyBox.bottom <= footer.top + 1 &&
          footer.bottom <= innerHeight + 1
        )
      }),
    )
    .toBe(true)
  const supplement = panel.getByLabel('补充要求（可选）', { exact: true })
  await supplement.focus()
  await supplement.scrollIntoViewIfNeeded()
  const body = await panel.locator('.el-drawer__body').boundingBox()
  const field = await supplement.boundingBox()
  expect(field!.y).toBeGreaterThanOrEqual(body!.y - 1)
  expect(field!.y + field!.height).toBeLessThanOrEqual(
    body!.y + body!.height + 1,
  )
  await expect(
    panel.locator('.el-drawer__footer button').last(),
  ).toBeInViewport()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true)
}

/** 正式页面的资料入口与失败恢复；API 用合成响应，不等同真实模型覆盖。 */
for (const theme of ['light', 'dark']) {
  test(`导演抽屉 ${theme}：参考资料、固定操作区和工具恢复`, async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await page.addInitScript(
      (value) => localStorage.setItem('starbridge.theme', value),
      theme,
    )
    const identity = await installFoundationFixture(page, [
      'products.entertainment',
      'studio.projects.read',
      'studio.projects.write',
      'studio.assets.read',
      'studio.assets.write',
      'files.read',
      'files.write',
      'sessions.read',
      'sessions.run',
    ])
    identity.signedIn = true
    const project: StudioProject = {
      id: 'director-source-film',
      title: '噜噜海岛旅行',
      brief: '噜噜去海南',
      revision: 1,
      sessionId: null,
      updated: '',
      assets: [],
      jobs: [],
      history: [],
      proposal: null,
      document: {
        adaptationMode: 'original',
        script: '',
        scenes: [],
        shots: [],
        assets: [],
        music: null,
        musicVolume: 1,
      },
    }
    const path = '/api/studio/projects/' + project.id
    await page.route('**' + path, (route) => route.fulfill({ json: project }))
    await page.route('**' + path + '/preparation', (route) =>
      route.fulfill({ json: { revision: project.revision, stages: [] } }),
    )
    await page.route('**/api/studio/assets', (route) =>
      route.fulfill({
        json: [
          {
            id: 'historic-lulu',
            name: '历史噜噜',
            description: '橙帽子和圆圆的脸',
            kind: 'character',
            version: 3,
            family: 'lulu',
            parent: null,
            project: null,
            fileId: null,
            voice: '',
          },
        ],
      }),
    )
    const picture = {
      id: 'portrait-file',
      name: '噜噜.png',
      mediaType: 'image/png',
      size: 1,
      sha256: 'fixture-digest',
    }
    await page.route('**/api/files/uploads', (route) =>
      route.fulfill({
        json: {
          id: 'upload',
          state: 'completed',
          fileId: picture.id,
          partSize: 1024,
          receivedParts: [],
        },
      }),
    )
    await page.route('**/api/files/' + picture.id, (route) =>
      route.fulfill({ json: picture }),
    )
    let preparations = 0,
      sends = 0,
      refreshed = false
    const messages: string[] = []
    await page.route('**' + path + '/director-context', (route) => {
      if (route.request().method() === 'GET')
        return route.fulfill({
          json: {
            vision: { available: true, model: '已配置视觉' },
            research: { available: true, model: '已配置查询' },
          },
        })
      preparations++
      const body = route.request().postDataJSON()
      expect(body.assetIds).toEqual(['historic-lulu'])
      expect(body.uploads).toEqual([{ fileId: picture.id, name: '噜噜出游' }])
      expect(body.analyzeImages).toBe(true)
      expect(body.researchQuery).toBe('海南海边特色')
      project.revision++
      return route.fulfill({
        json: {
          text: '参考形象：噜噜，圆脸橙帽子；海南海滩与椰林。',
          revision: project.revision,
          attachments: [],
          assetIds: ['project-lulu'],
          evidence: {
            vision: { text: '圆脸、橙帽子，沿用上传形象。', sources: [] },
            research: {
              text: '海滩与椰林可以作为旅行背景。',
              sources: [
                { title: '资料来源', url: 'https://example.com/hainan' },
              ],
            },
          },
        },
      })
    })
    await page.route('**' + path + '/conversation', (route) =>
      refreshed
        ? route.fulfill({ json: { sessionId: 'director-session' } })
        : route.fulfill({
            status: 409,
            json: {
              detail: '工具实现内容已改变，请绑定新版本',
              code: 'tool_implementation_changed',
            },
          }),
    )
    await page.route(
      '**' + path + '/conversation/refresh?purpose=director',
      (route) => {
        refreshed = true
        project.sessionId = 'director-session'
        return route.fulfill({
          json: {
            sessionId: 'director-session',
            agentId: 'director',
            updatedTools: 5,
          },
        })
      },
    )
    await page.route('**' + path + '/conversation/runtime', (route) =>
      route.fulfill({ json: { agent: { status: 'running' } } }),
    )
    let pendingReview = false
    const receiptId = 'call_' + 'b'.repeat(64)
    await page.route('**/api/sessions/director-session/snapshot', (route) =>
      route.fulfill({
        json: {
          session: { id: 'director-session', status: 'idle' },
          timeline: {
            items: pendingReview
              ? [
                  {
                    id: 'thinking',
                    type: 'system',
                    role: 'assistant',
                    content: {
                      kind: 'reasoning',
                      text: 'I am considering scene structure.',
                    },
                  },
                  {
                    id: 'reply',
                    type: 'message',
                    role: 'assistant',
                    content: { text: '请核对本次素材创建。' },
                  },
                ]
              : [],
            hasMore: false,
            nextSeq: null,
          },
          notices: pendingReview
            ? [
                {
                  id: 'plan-notice',
                  status: 'open',
                  title: '请审阅计划',
                  actions: [
                    {
                      actionId: 'submit',
                      input: {
                        uiSchema: {
                          component: 'inputRequest',
                          questions: [
                            {
                              id: receiptId,
                              prompt: '是否按此方案执行？',
                              intent: {
                                kind: 'plan-review',
                                approveOptionId: 'o_0',
                              },
                              multiple: false,
                              allowCustom: true,
                              options: [
                                { id: 'o_0', label: '确认执行' },
                                { id: 'o_1', label: '修改方案' },
                              ],
                            },
                          ],
                        },
                      },
                    },
                    { actionId: 'cancel', label: '取消' },
                  ],
                },
              ]
            : [],
          approvals: [],
          state: {},
          eventCursor: '',
          effectiveCapabilities: {},
        },
      }),
    )
    await page.route(
      '**/api/sessions/director-session/runtime/messages',
      (route) => {
        sends++
        const body = route.request().postDataJSON()
        messages.push(body.text)
        expect(body.attachments).toEqual([])
        return route.fulfill({ json: { accepted: true } })
      },
    )
    await page.goto('/#/entertainment/' + project.id + '?section=script')
    await mkdir(capture, { recursive: true })
    for (const width of [390, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: 960 })
      await expect(
        page.getByRole('button', { name: '让导演起草', exact: true }),
      ).toBeVisible()
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      ).toBe(true)
      await page.screenshot({
        path: resolve(capture, `script-${theme}-${width}.png`),
        animations: 'disabled',
      })
    }
    await page.getByRole('button', { name: '让导演起草', exact: true }).click()
    const panel = page.getByRole('dialog', { name: '作品导演助手' })
    await panel
      .getByLabel('你的故事想法', { exact: true })
      .fill('噜噜和朋友去海南，轻松可爱，四个镜头。')
    await panel.locator('input[type=file]').setInputFiles({
      name: '噜噜.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB6kAAAAASUVORK5CYII=',
        'base64',
      ),
    })
    await expect(panel.getByLabel('参考形象名称')).toHaveValue('噜噜')
    await panel.getByLabel('参考形象名称').fill('噜噜出游')
    const visionLabel = panel.getByText('让 AI 理解参考图，提取外观和风格', {
      exact: true,
    })
    const visionChoice = panel.getByRole('checkbox', {
      name: '让 AI 理解参考图，提取外观和风格',
    })
    await visionLabel.click()
    await expect(visionChoice).not.toBeChecked()
    await visionLabel.click()
    await expect(visionChoice).toBeChecked()
    await panel.getByRole('button', { name: '从个人形象库选择' }).click()
    const library = page.getByRole('dialog', {
      name: '选择个人形象',
      exact: true,
    })
    await library
      .getByRole('button', { name: '选择形象 历史噜噜', exact: true })
      .click()
    await library.getByRole('button', { name: '完成选择' }).click()
    await panel.getByText('联网查询地点和故事背景', { exact: true }).click()
    await expect(
      panel.getByRole('checkbox', { name: '联网查询地点和故事背景' }),
    ).toBeChecked()
    await panel.getByLabel('联网查询主题').fill('海南海边特色')
    await panel
      .getByLabel('补充要求（可选）', { exact: true })
      .fill('保留橙帽子，让结尾温暖一些。')
    // 关闭抽屉只是收起工作区，不丢弃尚未提交的想法和上传资料。
    await panel.locator('.el-drawer__close-btn').click()
    await page.getByRole('button', { name: '让导演起草', exact: true }).click()
    await expect(panel.getByLabel('参考形象名称')).toHaveValue('噜噜出游')
    await expect(
      panel.getByLabel('补充要求（可选）', { exact: true }),
    ).toHaveValue(/橙帽子/)
    for (const width of [319, 390, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: 960 })
      await inspectDrawer(page, panel)
      await panel
        .getByText('参考形象', { exact: true })
        .scrollIntoViewIfNeeded()
      await page.screenshot({
        path: resolve(capture, `director-input-${theme}-${width}.png`),
        animations: 'disabled',
      })
    }
    expect(preparations).toBe(0)
    await panel.getByRole('button', { name: '开始根据构想起草故事' }).click()
    await expect(
      panel.getByRole('button', { name: '更新预置助手工具并重试' }),
    ).toBeVisible()
    await inspectDrawer(page, panel)
    await page.screenshot({
      path: resolve(capture, `director-recovery-${theme}.png`),
      animations: 'disabled',
    })
    expect(preparations).toBe(1)
    expect(sends).toBe(0)
    await expect(panel.getByLabel('你的故事想法', { exact: true })).toHaveValue(
      /噜噜和朋友/,
    )
    await panel.getByRole('button', { name: '更新预置助手工具并重试' }).click()
    await expect.poll(() => sends).toBe(1)
    expect(preparations).toBe(1)
    expect(messages[0]).toContain('四个镜头')
    expect(messages[0]).toContain('圆脸橙帽子')
    await panel.getByText('已整理的参考资料', { exact: true }).click()
    await expect(panel.getByRole('link', { name: '资料来源' })).toHaveAttribute(
      'href',
      'https://example.com/hainan',
    )
    for (const width of [390, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: 960 })
      await inspectDrawer(page, panel)
      await expect(
        panel.getByRole('button', { name: '开始根据构想起草故事' }),
      ).toBeInViewport()
      await page.screenshot({
        path: resolve(capture, `director-evidence-${theme}-${width}.png`),
        animations: 'disabled',
      })
    }
    let planReads = 0
    await page.route(
      '**/api/sessions/director-session/plans/' + receiptId,
      (route) => {
        planReads++
        return planReads === 1
          ? route.fulfill({ status: 503, json: { detail: '方案暂不可用' } })
          : route.fulfill({
              json: {
                plan: {
                  id: receiptId,
                  sessionId: 'director-session',
                  version: 1,
                  state: 'prepared',
                  title: '创建版本素材',
                  summary: '核对目标与输入',
                  document: {
                    arguments: {
                      kind: 'prop',
                      name: '合成椰子',
                      description: '海滩上可以拾取的椰子，保留圆润造型。',
                      metadata: { source: 'test' },
                    },
                  },
                },
              },
            })
      },
    )
    pendingReview = true
    await expect(
      panel.getByText('暂时无法核对方案：方案暂不可用'),
    ).toBeVisible()
    await expect(
      panel.getByRole('radio', { name: '确认执行', exact: true }),
    ).toBeDisabled()
    await expect(
      panel.getByRole('radio', { name: '修改方案', exact: true }),
    ).toBeEnabled()
    await panel.getByRole('button', { name: '重新读取方案' }).click()
    await expect(panel.getByText('合成椰子', { exact: true })).toBeVisible()
    await expect(
      panel.getByRole('radio', { name: '确认执行', exact: true }),
    ).toBeEnabled()
    await expect(
      panel.getByRole('button', { name: '提交回复', exact: true }),
    ).toBeDisabled()
    await panel.getByText('创作对话记录', { exact: true }).click()
    await expect(panel.getByText('请核对本次素材创建。')).toBeVisible()
    await expect(
      panel.getByText('I am considering scene structure.'),
    ).not.toBeVisible()
    await panel.getByText('思考过程', { exact: true }).click()
    await expect(
      panel.getByText('I am considering scene structure.'),
    ).toBeVisible()
    await panel.getByText('思考过程', { exact: true }).click()
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 960 })
      await panel
        .getByText('创建版本素材', { exact: true })
        .scrollIntoViewIfNeeded()
      await page.screenshot({
        path: resolve(capture, `director-plan-${theme}-${width}.png`),
        animations: 'disabled',
      })
    }
    let response: unknown
    await page.route(
      '**/api/sessions/director-session/runtime/notices/plan-notice/respond',
      (route) => {
        response = route.request().postDataJSON()
        pendingReview = false
        return route.fulfill({ json: { resolved: true } })
      },
    )
    await panel.getByText('确认执行', { exact: true }).click()
    await panel.getByRole('button', { name: '提交回复', exact: true }).click()
    await expect
      .poll(() => response)
      .toEqual({
        actionId: 'submit',
        input: { answers: { [receiptId]: { optionIds: ['o_0'] } } },
      })
  })
}
