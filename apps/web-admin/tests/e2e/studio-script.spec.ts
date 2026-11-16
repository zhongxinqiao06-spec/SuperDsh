import { expect, test, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installFoundationFixture } from './foundation-fixture'
import type { StudioProject } from '../../fronted/src/types/studio/studio'

/** 仅显式视觉验收保留截图，目标必须在仓库验证目录内；不保留临时账号与数据库。 */
async function capture(page: Page, name: string) {
  const target = process.env.WEB_ADMIN_DESIGN_CAPTURE_DIR
  if (!target) return
  const root = fileURLToPath(
    new URL(
      '../../../../.superdsh-work/web-admin-validation/',
      import.meta.url,
    ),
  )
  const path = relative(root, resolve(target))
  if (!path || path.startsWith('..') || isAbsolute(path))
    throw new Error('视觉验收截图必须输出到独立验证目录')
  await mkdir(target, { recursive: true })
  await page.screenshot({ path: resolve(target, name), animations: 'disabled' })
}

/** 只模拟 DSH 回应与 API 状态，不调用真实模型或用户作品；界面操作使用正式 Vue 组件。 */
async function workspace(page: Page) {
  const identity = await installFoundationFixture(page, [
    'products.entertainment',
    'studio.projects.read',
    'studio.projects.write',
    'studio.assets.read',
    'sessions.read',
    'sessions.run',
  ])
  identity.signedIn = true
  const project: StudioProject = {
    id: 'script-film',
    title: '雨后站台',
    brief: '两人在雨后站台重逢，决定一起出发。',
    revision: 1,
    sessionId: null,
    updated: '',
    assets: [],
    history: [],
    jobs: [],
    proposal: null,
    document: {
      adaptationMode: 'original',
      script: '',
      scenes: [],
      assets: [],
      shots: [],
      music: null,
      musicVolume: 1,
    },
  }
  const messages: string[] = []
  let reviewed = false,
    confirmed = false
  await page.route('**/api/studio/projects/script-film', async (route) => {
    if (route.request().method() === 'PUT') {
      project.document = route.request().postDataJSON().document
      project.revision++
    }
    return route.fulfill({ json: project })
  })
  await page.route('**/api/studio/projects/script-film/preparation', (route) =>
    route.fulfill({
      json: {
        revision: project.revision,
        stages: [
          {
            key: 'script',
            title: '剧本与场次',
            status: confirmed
              ? 'confirmed'
              : project.document.script
                ? 'needs_review'
                : 'blocked',
            review: null,
            issues: project.document.script
              ? []
              : [
                  {
                    key: 'script.empty',
                    message: '请补充剧本',
                    target: null,
                    waivable: false,
                  },
                ],
          },
        ],
      },
    }),
  )
  await page.route(
    '**/api/studio/projects/script-film/stages/script/confirm',
    (route) => {
      expect(route.request().postDataJSON().acknowledged).toBe(true)
      confirmed = true
      return route.fulfill({ json: {} })
    },
  )
  await page.route(
    '**/api/studio/projects/script-film/conversation',
    (route) => {
      project.sessionId = 'director'
      return route.fulfill({ json: { sessionId: 'director' } })
    },
  )
  await page.route(
    '**/api/studio/projects/script-film/conversation/runtime',
    (route) => route.fulfill({ json: { agent: { status: 'running' } } }),
  )
  await page.route('**/api/sessions/director/snapshot', (route) =>
    route.fulfill({
      json: {
        session: {
          id: 'director',
          status: messages.length && !reviewed ? 'running' : 'idle',
        },
        state: {},
        timeline: { items: [], hasMore: false, nextSeq: null },
        notices: [],
        approvals: [],
        effectiveCapabilities: {},
        eventCursor: '',
      },
    }),
  )
  await page.route('**/api/sessions/director/runtime/messages', (route) => {
    messages.push(route.request().postDataJSON().text)
    project.proposal = { id: 'draft', revision: project.revision, shots: [] }
    return route.fulfill({ json: {} })
  })
  const scenes = [
    {
      id: 'platform',
      title: '站台 · 雨后',
      synopsis: '小林与小禾重逢，决定一起出发。',
    },
  ]
  await page.route(
    '**/api/studio/projects/script-film/proposals/draft',
    (route) =>
      route.fulfill({
        json: {
          id: 'draft',
          baseRevision: 1,
          revision: project.revision,
          state: 'pending',
          changes: [
            {
              key: 'script',
              label: '剧本正文',
              before: '',
              current: '',
              after: '雨后的站台。小林说：我们一起出发吧。小禾点头。',
              conflict: false,
            },
            {
              key: 'scenes',
              label: '场次安排',
              before: [],
              current: [],
              after: scenes,
              conflict: false,
            },
          ],
        },
      }),
  )
  await page.route(
    '**/api/studio/projects/script-film/proposals/draft/review',
    (route) => {
      const body = route.request().postDataJSON()
      expect(body.selected).toEqual(['script', 'scenes'])
      project.document.script = '雨后的站台。小林说：我们一起出发吧。小禾点头。'
      project.document.scenes = scenes
      project.proposal = null
      project.revision++
      reviewed = true
      return route.fulfill({ json: { revision: project.revision } })
    },
  )
  await page.goto('/#/entertainment/script-film?section=script')
  return { project, messages }
}

test('AI 编辑抽屉在缩放和窄屏打开时完整位于屏幕内', async ({ page }) => {
  await workspace(page)
  await page.route('**/api/studio/projects/script-film/text-edits', (route) =>
    route.fulfill({
      json: [
        {
          id: 'local-edit',
          label: '站台',
          scope: 'selection',
          original: '雨后的站台，两人再次相见。',
          suggestion: '雨停了，他们在站台再次相见。',
          instruction: '润色原稿',
          state: 'ready',
          revision: 1,
          conflict: null,
        },
      ],
    }),
  )
  await page.getByLabel('剧本正文').fill('雨后的站台，两人再次相见。')
  await page.getByLabel('剧本正文').press('ControlOrMeta+A')
  await page.getByRole('button', { name: 'AI 修改选段', exact: true }).click()
  const panel = page.getByRole('dialog', { name: 'AI 剧本编辑' })
  await panel.getByRole('button', { name: /站台 · 润色原稿/ }).click()
  for (const width of [1440, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 960 })
    await expect
      .poll(() =>
        panel.evaluate((node) => {
          const box = node.getBoundingClientRect()
          return {
            left: box.left >= 0,
            right: box.right <= innerWidth + 1,
            overflow: node.scrollWidth > node.clientWidth + 1,
          }
        }),
      )
      .toEqual({ left: true, right: true, overflow: false })
    await capture(page, `script-ai-drawer-${width}.png`)
  }
})

test('从原稿摘录场次、调整顺序、阅读并确认，四档宽度均可操作', async ({
  page,
}) => {
  const { project } = await workspace(page)
  await expect(
    page.getByRole('heading', { name: '先把故事讲清楚' }),
  ).toBeVisible()
  await expect(page.getByText('我已审阅本阶段内容')).toHaveCount(0)
  await page
    .getByLabel('剧本正文')
    .fill('小林在站台重逢小禾。\n两人决定坐火车出发。')
  await page.getByLabel('剧本正文').press('ControlOrMeta+A')
  await page.getByRole('button', { name: '选中文字建一场' }).click()
  await expect(page.getByLabel('场次摘要')).toHaveValue(/站台重逢/)
  await page.getByLabel('场次名称').fill('站台重逢')
  const firstId = project.document.scenes?.[0]?.id
  await page.getByRole('button', { name: '添加场次' }).click()
  await page.getByLabel('场次名称').fill('车厢出发')
  await page.getByLabel('场次摘要').fill('列车驶离站台。')
  await page.getByRole('button', { name: '上移', exact: true }).click()
  await expect(
    page.getByLabel('场次目录').getByRole('button').first(),
  ).toContainText('车厢出发')
  await expect.poll(() => project.document.scenes?.[1]?.title).toBe('站台重逢')
  expect(project.document.script).toContain('小林在站台重逢小禾')
  if (firstId) expect(project.document.scenes?.[1]?.id).toBe(firstId)
  await page.getByRole('button', { name: '阅读剧本' }).click()
  await expect(page.getByLabel('剧本阅读稿')).toContainText('坐火车')
  await page.getByRole('button', { name: '继续编辑' }).click()
  for (const width of [390, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true)
      await expect(
        page.getByRole('button', { name: '审阅剧本并继续' }),
      ).toBeEnabled()
    }
  }
  await page.emulateMedia({ colorScheme: 'light' })
  await page
    .getByRole('button', { name: '审阅剧本并继续' })
    .scrollIntoViewIfNeeded()
  await capture(page, '06-script-arranged.png')
  await page.getByRole('button', { name: '审阅剧本并继续' }).click()
  const dialog = page.getByRole('dialog', { name: '确认本次剧本' })
  await expect(dialog.getByLabel('本次确认的剧本')).toContainText('重逢')
  await capture(page, '07-script-confirmation.png')
  await dialog.getByRole('button', { name: '返回修改' }).click()
  await expect(page.getByLabel('剧本正文')).toHaveValue(/重逢/)
  await page.getByRole('button', { name: '审阅剧本并继续' }).click()
  await dialog.getByRole('button', { name: '确认剧本，进入人物设定' }).click()
  await expect(page).toHaveURL(/section=cast/)
})

test('构想起草需明确发送，建议可定位审阅，采用后才出现原稿和场次', async ({
  page,
}) => {
  const { project, messages } = await workspace(page)
  await page.getByRole('button', { name: '让导演起草' }).click()
  const drawer = page.getByRole('dialog', { name: '作品导演助手' })
  await expect(
    drawer.getByRole('heading', { name: '根据构想起草故事' }),
  ).toBeVisible()
  await expect(drawer).toContainText('这一步不生成图片、视频或配音')
  expect(messages).toHaveLength(0)
  await drawer.getByLabel('补充要求（可选）').fill('保留结尾悬念。')
  await drawer.getByRole('button', { name: '开始根据构想起草故事' }).click()
  await expect.poll(() => messages.length).toBe(1)
  expect(messages[0]).toContain('保留结尾悬念')
  expect(messages[0]).toContain('重逢')
  await expect(drawer.getByRole('button', { name: '去审阅方案' })).toBeVisible()
  expect(project.document.script).toBe('')
  await drawer.getByRole('button', { name: '去审阅方案' }).click()
  await expect(page.getByRole('heading', { name: '方案对比' })).toBeVisible()
  await page.getByRole('button', { name: '选择无冲突建议' }).click()
  await page.getByRole('button', { name: '采用选中字段' }).click()
  await expect(page.getByLabel('剧本正文')).toHaveValue(/我们一起出发/)
  await expect(page.getByLabel('场次目录')).toContainText('站台 · 雨后')
  await expect(
    page.getByRole('button', { name: '整理场次与分镜', exact: true }),
  ).toBeEnabled()
  await page.reload()
  await expect(page.getByLabel('剧本正文')).toHaveValue(/我们一起出发/)
  expect(messages).toHaveLength(1)
})
