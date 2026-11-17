import { test, expect } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { installFoundationFixture } from './foundation-fixture'
import type { StudioProject } from '../../fronted/src/types/studio/studio'
import { newShot } from '../../fronted/src/utils/studio/storyboard'

function emptyProject(): StudioProject {
  return {
    id: 'film',
    title: '夜站',
    revision: 1,
    sessionId: null,
    updated: new Date().toISOString(),
    assets: [],
    jobs: [],
    history: [],
    proposal: null,
    document: {
      script: '',
      assets: [],
      shots: [],
      music: null,
      musicVolume: 0.25,
    },
  }
}

test('只读作品可查看各步骤，剧本分镜和剪辑控件不能修改', async ({ page }) => {
  const identity = await installFoundationFixture(page, [
    'products.entertainment',
    'studio.projects.read',
    'studio.assets.read',
  ])
  identity.signedIn = true
  const project = emptyProject()
  project.document.shots = [{ ...newShot(), action: '只读镜头' }]
  await page.route('**/api/studio/projects/film', (route) =>
    route.fulfill({ json: project }),
  )
  await page.goto('/#/entertainment/film?section=storyboard')
  await expect(page.getByRole('button', { name: '添加分镜' })).toHaveCount(0)
  await expect(page.getByLabel('动作摘要')).toBeDisabled()
  const steps = page.getByRole('navigation', { name: '作品工作区' })
  await steps.getByRole('link', { name: '剪辑与字幕' }).click()
  await expect(page.getByLabel('入点（秒）')).toBeDisabled()
  await expect(page.getByRole('button', { name: '导出 MP4' })).toBeDisabled()
  await steps.getByRole('link', { name: '剧本与场次' }).click()
  await expect(page.getByLabel('剧本正文')).toBeDisabled()
  await expect(page.getByRole('button', { name: '保存工程' })).toBeDisabled()
})

test('镜头候选单独预览、对比、采用和换回，刷新恢复同一镜头及时间线', async ({
  page,
}) => {
  const identity = await installFoundationFixture(page, [
    'products.entertainment',
    'studio.projects.read',
    'studio.projects.write',
    'studio.assets.read',
    'studio.assets.write',
  ])
  identity.signedIn = true
  const project = emptyProject()
  const first = {
    ...newShot(),
    id: 'opening',
    action: '站台全景',
    trimEnd: 2500,
  }
  const third = {
    ...newShot(),
    id: 'rain',
    action: '雨夜车站',
    candidate: 'before',
  }
  project.document.shots = [first, third]
  project.jobs = ['after', 'before'].map((id) => ({
    id,
    subject: third.id,
    kind: 'video',
    revision: 1,
    state: 'ready',
    duration: 5000,
    error: null,
  }))
  let failed = true
  let saves = 0
  await page.route('**/api/studio/projects/film', async (route) => {
    if (route.request().method() === 'PUT') {
      saves++
      if (failed) {
        failed = false
        return route.fulfill({ status: 409, json: { detail: '修订冲突' } })
      }
      const body = route.request().postDataJSON()
      expect(body.revision).toBe(project.revision)
      project.document = body.document
      return route.fulfill({ json: { revision: ++project.revision } })
    }
    return route.fulfill({ json: project })
  })
  await page.route('**/api/studio/projects/film/media/**', (route) =>
    route.fulfill(
      route.request().method() === 'POST'
        ? { json: { ready: true } }
        : { status: 204 },
    ),
  )
  await page.goto('/#/entertainment/film?section=storyboard&shot=rain')
  const monitor = page.getByRole('region', { name: '镜头预览与候选' })
  await monitor.getByRole('button', { name: /候选 2/ }).click()
  await monitor.getByRole('button', { name: '对比候选' }).click()
  await expect(monitor.locator('video[controls]')).toHaveCount(2)
  for (const width of [390, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true)
    }
  }
  expect(project.document.shots[1]?.candidate).toBe('before')
  const adopt = monitor.getByRole('button', { name: '采用到时间线' })
  await adopt.click()
  await page.getByRole('button', { name: '载入最新工程' }).click()
  await expect(adopt).toBeEnabled()
  expect(project.document.shots[1]?.candidate).toBe('before')
  await adopt.click()
  await expect.poll(() => project.document.shots[1]?.candidate).toBe('after')
  await page.reload()
  await expect(
    monitor.getByRole('button', { name: '时间线已采用' }),
  ).toBeDisabled()
  await monitor.getByRole('button', { name: /候选 1/ }).click()
  await monitor.getByRole('button', { name: '采用到时间线' }).click()
  await expect.poll(() => project.document.shots[1]?.candidate).toBe('before')
  await page.getByRole('link', { name: '剪辑与字幕', exact: true }).click()
  await expect(page.locator('.timeline-picture video')).toHaveAttribute(
    'src',
    /\/media\/before$/,
  )
  await expect(page.getByRole('region', { name: '作品时间线' })).toContainText(
    '7.5 秒',
  )
  for (const width of [390, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    for (const colorScheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme })
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true)
    }
  }
  expect(project.document.shots[0]?.trimEnd).toBe(2500)
  expect(saves).toBe(3)
})

test('作品步骤可直达、后退和刷新，剧本、分镜与剪辑共用工程', async ({
  page,
}) => {
  const state = await installFoundationFixture(page, [
    'products.office',
    'products.entertainment',
    'studio.projects.read',
    'studio.projects.write',
    'studio.assets.read',
    'studio.assets.write',
    'sessions.read',
    'sessions.run',
    'models.use',
  ])
  state.signedIn = true
  const project = emptyProject()
  await page.route(
    (url) => url.pathname.startsWith('/api/studio/'),
    async (route) => {
      const path = new URL(route.request().url()).pathname
      if (path.endsWith('/preparation'))
        return route.fulfill({
          json: { revision: project.revision, stages: [] },
        })
      if (path.endsWith('/director-context'))
        return route.fulfill({
          json: {
            vision: { available: false },
            research: { available: false },
          },
        })
      if (path.endsWith('/catalog'))
        return route.fulfill({
          json: { configurations: [], defaults: [], agents: [] },
        })
      if (path.endsWith('/projects')) return route.fulfill({ json: [project] })
      if (path.endsWith('/jobs')) {
        expect(route.request().postDataJSON()).toMatchObject({
          revision: project.revision,
          export: true,
        })
        const job = {
          id: 'render',
          subject: 'timeline',
          kind: 'export' as const,
          revision: project.revision,
          state: 'ready',
          error: null,
          duration: 8000,
        }
        project.jobs = [job]
        return route.fulfill({ json: [job] })
      }
      if (path.endsWith('/access'))
        return route.fulfill({ json: { ready: true } })
      if (path.endsWith('/media/render')) return route.fulfill({ status: 204 })
      if (route.request().method() === 'PUT') {
        const body = route.request().postDataJSON()
        expect(body.revision).toBe(project.revision)
        project.document = body.document
        project.revision++
        return route.fulfill({ json: { revision: project.revision } })
      }
      return route.fulfill({ json: project })
    },
  )
  await page.goto('/#/entertainment/film?section=jobs')
  const sections = page.getByRole('navigation', { name: '作品工作区' })
  const step = (name: string) =>
    sections.getByRole('link', { name, exact: true })
  await expect(step('批量制作')).toHaveAttribute('aria-current', 'page')
  await expect(
    page.getByRole('heading', { name: '本作品的制作任务' }),
  ).toBeVisible()
  await step('剧本与场次').click()
  await page.getByLabel('剧本正文').fill('小林和小禾在车站相遇。')
  await page.getByRole('button', { name: '导演助手', exact: true }).click()
  await page.getByLabel('给导演的指令').fill('请保留角色的原造型。')
  await page
    .getByRole('dialog', { name: '作品导演助手' })
    .locator('.el-drawer__close-btn')
    .click()
  await step('角色与场景').click()
  await page.goBack()
  await expect(page.getByLabel('剧本正文')).toHaveValue(
    '小林和小禾在车站相遇。',
  )
  await page.getByRole('button', { name: '导演助手', exact: true }).click()
  await expect(page.getByLabel('给导演的指令')).toHaveValue(
    '请保留角色的原造型。',
  )
  await page.getByLabel('给导演的指令').fill('')
  await page
    .getByRole('dialog', { name: '作品导演助手' })
    .locator('.el-drawer__close-btn')
    .click()
  await page.goForward()
  await expect(step('角色与场景')).toHaveAttribute('aria-current', 'page')
  await page.getByRole('button', { name: '添加或引用素材' }).first().click()
  await page.getByLabel('名称', { exact: true }).fill('尚未提交角色')
  await page
    .getByRole('dialog', { name: '项目素材与个人库' })
    .locator('.el-drawer__close-btn')
    .click()
  await page.getByRole('link', { name: '作品首页' }).click()
  await expect(page.getByRole('dialog', { name: '确认操作' })).toBeVisible()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await expect(step('角色与场景')).toHaveAttribute('aria-current', 'page')
  await page.getByRole('button', { name: '添加或引用素材' }).first().click()
  await page.getByLabel('名称', { exact: true }).fill('')
  await page
    .getByRole('dialog', { name: '项目素材与个人库' })
    .locator('.el-drawer__close-btn')
    .click()
  await expect
    .poll(() => project.document.script)
    .toBe('小林和小禾在车站相遇。')
  await step('分镜设计').click()
  await page.getByRole('button', { name: '添加分镜' }).click()
  await page.getByLabel('动作摘要').fill('小林推开门')
  await page.getByRole('button', { name: '复制', exact: true }).click()
  await page.getByLabel('动作摘要').fill('小禾回头')
  await page.getByRole('button', { name: '保存工程' }).click()
  await step('剪辑与字幕').click()
  await page.getByRole('button', { name: '提前' }).last().click()
  await page.getByLabel('出点（秒）').first().fill('3')
  await page.getByRole('button', { name: '保存工程' }).click()
  await expect.poll(() => project.document.shots[0]?.action).toBe('小禾回头')
  await expect.poll(() => project.document.shots[0]?.trimEnd).toBe(3000)
  expect(new Set(project.document.shots.map((s) => s.id)).size).toBe(2)
  await page.getByRole('button', { name: '预览当前剪辑' }).click()
  await expect(
    page.getByRole('heading', {
      name: '媒体预览 · 工程版本 ' + project.revision,
    }),
  ).toBeVisible()
  await expect(page.locator('video[controls]')).toHaveAttribute(
    'src',
    /\/media\/render$/,
  )
  // 媒体请求保持模拟：用竖屏海报验证固有比例，不将此用例描述为实际视频解码验收。
  await page.locator('video[controls]').evaluate((element) => {
    const video = element as HTMLVideoElement
    video.poster =
      'data:image/svg+xml,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280"><rect width="720" height="1280" fill="#252a30"/><text x="360" y="640" fill="white" text-anchor="middle" font-size="36">Portrait preview fixture</text></svg>',
      )
  })
  const mediaDialog = page.getByRole('dialog', {
    name: '媒体预览 · 工程版本 ' + project.revision,
  })
  const output = resolve(
    process.env.WEB_ADMIN_VALIDATION_DIR ??
      '.superdsh-work/web-admin-validation/lulu-workflow/media-preview',
    'screens',
  )
  await mkdir(output, { recursive: true })
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 844 })
    await expect(mediaDialog.locator('.el-dialog__header')).toBeInViewport()
    await expect(
      mediaDialog.getByRole('button', { name: '关闭', exact: true }),
    ).toBeInViewport()
    await expect(page.locator('video[controls]')).toBeInViewport()
    // 等待弹窗入场动画与响应式重新排版，不能把过渡帧当作越界。
    await expect
      .poll(async () => {
        const rect = await mediaDialog.boundingBox()
        return rect !== null && rect.y >= 0 && rect.y + rect.height <= 845
      })
      .toBe(true)
    const bounds = await mediaDialog.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1)
    expect(bounds!.y).toBeGreaterThanOrEqual(0)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(845)
    const videoBounds = await page.locator('video[controls]').boundingBox()
    expect(videoBounds!.height).toBeLessThanOrEqual(844 * 0.65 + 1)
    await page.screenshot({
      path: resolve(output, `media-preview-${width}.png`),
      animations: 'disabled',
    })
  }
  await mediaDialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.locator('video[controls]')).toHaveCount(0)
  await page.getByRole('button', { name: '预览当前剪辑' }).click()
  await expect(mediaDialog).toBeVisible()
  await page.reload()
  await expect(step('剪辑与字幕')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByLabel('出点（秒）').first()).toHaveValue('3')
  await page.getByRole('button', { name: '导出 MP4' }).click()
  const confirmation = page.getByRole('dialog', { name: '确认导出当前工程' })
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole('button', { name: '导出这一版 MP4' }).click()
  await expect(step('成片交付')).toHaveAttribute('aria-current', 'page')
  await step('剧本与场次').click()
  await expect(page.getByLabel('剧本正文')).toHaveValue(
    '小林和小禾在车站相遇。',
  )
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveClass(/dark/)
  for (const name of [
    '剧本与场次',
    '角色与场景',
    '分镜设计',
    '剪辑与字幕',
    '批量制作',
  ]) {
    await step(name).click()
    await expect(step(name)).toHaveAttribute('aria-current', 'page')
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true)
  }
})

test('仅有娱乐权限可以编剧本和分镜，独立的会话、模型和文件权限受限', async ({
  page,
}) => {
  const identity = await installFoundationFixture(page, [
    'products.entertainment',
    'studio.projects.read',
    'studio.projects.write',
    'studio.assets.read',
    'studio.assets.write',
  ])
  identity.signedIn = true
  const project = { ...emptyProject(), sessionId: 'unreadable' }
  await page.route('**/api/studio/projects/film', (route) =>
    route.fulfill({ json: project }),
  )
  await page.goto('/#/entertainment/film?section=script')
  await expect(page.getByLabel('剧本正文')).toBeEditable()
  await page.getByRole('button', { name: '导演助手', exact: true }).click()
  await expect(page.getByText('创作对话需要会话读取和运行权限。')).toBeVisible()
  await expect(page.getByLabel('给导演的指令')).toHaveCount(0)
  await page
    .getByRole('dialog', { name: '作品导演助手' })
    .locator('.el-drawer__close-btn')
    .click()
  const nav = page.getByRole('navigation', { name: '作品工作区' })
  await nav.getByRole('link', { name: '角色与场景' }).click()
  await page.getByRole('button', { name: '添加或引用素材' }).first().click()
  await page.getByLabel('名称', { exact: true }).fill('小林')
  await page
    .getByRole('dialog', { name: '项目素材与个人库' })
    .locator('.el-drawer__close-btn')
    .click()
  await page.getByRole('link', { name: '作品首页' }).click()
  await page
    .getByRole('dialog', { name: '确认操作' })
    .getByRole('button', { name: '取消' })
    .click()
  await page.getByRole('button', { name: '添加或引用素材' }).first().click()
  await expect(page.getByLabel('名称', { exact: true })).toHaveValue('小林')
  await page
    .getByRole('dialog', { name: '项目素材与个人库' })
    .locator('.el-drawer__close-btn')
    .click()
  await nav.getByRole('link', { name: '分镜设计' }).click()
  await page.getByRole('button', { name: '添加分镜' }).click()
  await expect(page.getByLabel('动作摘要')).toBeEditable()
  await expect(page.getByRole('button', { name: '批量生成' })).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: '生成此镜候选' }),
  ).toBeDisabled()
  await nav.getByRole('link', { name: '角色与场景' }).click()
  await expect(page.getByLabel('上传参考文件')).toHaveCount(0)
  expect(
    identity.requests.some((r) => /studio\/catalog|unreadable/.test(r)),
  ).toBe(false)
})

for (const section of ['storyboard', 'sample'] as const) {
  test(`分镜生成沿用模型授权和配置，${section} 预检遵守制作契约且确认后才提交`, async ({
    page,
  }) => {
    const identity = await installFoundationFixture(page, [
      'products.entertainment',
      'studio.projects.read',
      'studio.projects.write',
      'studio.assets.read',
      'studio.assets.write',
      'models.use',
    ])
    identity.signedIn = true
    const project = emptyProject()
    if (section === 'sample')
      project.document.shots = [{ ...newShot(), action: '列车进站' }]
    await page.route('**/api/studio/projects/film', async (route) => {
      if (route.request().method() === 'PUT') {
        project.document = route.request().postDataJSON().document
        return route.fulfill({ json: { revision: ++project.revision } })
      }
      return route.fulfill({ json: project })
    })
    await page.route('**/api/studio/catalog', (route) =>
      route.fulfill({
        json: {
          configurations: ['电影镜头', '动画镜头'].map((name, i) => ({
            id: 'video-' + i,
            name,
            capability: 'video.generate',
            connectionId: 'fixture-provider',
            modelId: 'fixture-video',
            parameters: {},
          })),
          defaults: [
            { capability: 'video.generate', configurationId: 'video-0' },
          ],
          agents: [],
        },
      }),
    )
    const requests: string[] = []
    let chosen = '',
      subject = ''
    await page.route(
      '**/api/studio/projects/film/generation-plans',
      async (route) => {
        const body = route.request().postDataJSON()
        // 严格复现服务端禁止未知字段的契约，export 只属于导出入口。
        expect(body).toEqual({
          revision: project.revision,
          requestKey: expect.stringMatching(/^[\da-f-]{36}$/i),
          mode: 'selected',
          shots: [project.document.shots[0]!.id],
          lines: [],
          video: 'video-1',
        })
        chosen = body.video
        subject = body.shots[0]
        return route.fulfill({
          json: {
            id: 'plan',
            revision: project.revision,
            planHash: 'f'.repeat(64),
            state: 'draft',
            items: [
              {
                target: subject,
                kind: 'video',
                label: '列车进站',
                model: chosen,
                selected: true,
                status: 'missing',
                seconds: 5,
              },
            ],
            issues: [],
          },
        })
      },
    )
    await page.route(
      '**/api/studio/projects/film/generation-plans/plan/confirm',
      async (route) => {
        requests.push(chosen)
        project.jobs = [
          {
            id: 'media-job',
            kind: 'video',
            subject,
            revision: project.revision,
            state: 'queued',
            duration: null,
            error: null,
          },
        ]
        return route.fulfill({ json: { jobs: project.jobs } })
      },
    )
    await page.goto('/#/entertainment/film?section=' + section)
    if (section === 'storyboard') {
      await page.getByRole('button', { name: '添加分镜' }).click()
      await page.getByLabel('动作摘要').fill('列车进站')
      await page.getByRole('button', { name: '生成此镜候选' }).click()
    } else {
      await page.getByRole('button', { name: '确认本镜试做范围' }).click()
    }
    const dialog = page.getByRole('dialog', { name: '确认生成任务' })
    await expect(dialog.getByLabel('文生视频模型')).toHaveValue('video-0')
    await dialog.getByLabel('文生视频模型').selectOption('video-1')
    expect(requests).toHaveLength(0)
    await dialog.getByRole('button', { name: '检查生成方案' }).click()
    expect(requests).toHaveLength(0)
    await page
      .getByRole('dialog', { name: '制作前检查' })
      .getByRole('button', { name: '确认用量并提交' })
      .click()
    if (section === 'storyboard') {
      await expect(page).toHaveURL(/[?&]section=production(?:&|$)/)
      await expect(
        page.getByRole('heading', { name: /动态镜头.*版本/ }),
      ).toBeVisible()
    } else {
      await expect(page).toHaveURL(/[?&]section=sample(?:&|$)/)
      await expect(dialog).not.toBeVisible()
    }
    expect(requests).toEqual(['video-1'])
  })
}

test('制作页展示默认选择和精简任务内容，角色试听不跳转无关镜头', async ({
  page,
}) => {
  const identity = await installFoundationFixture(page, [
    'products.entertainment',
    'studio.projects.read',
    'studio.projects.write',
    'studio.assets.read',
    'models.use',
  ])
  identity.signedIn = true
  const project = emptyProject()
  const action =
    '噜噜沿着海南海边栈道向前走，保持原来的造型和轻松的步伐。'.repeat(9)
  project.document.shots = [
    { ...newShot(), id: 'opening', sceneId: 'beach', action },
  ]
  project.document.scenes = [{ id: 'beach', title: '海南海边', synopsis: '' }]
  project.assets = [
    {
      id: 'role',
      family: 'role-family',
      parent: null,
      project: 'film',
      kind: 'character',
      name: '噜噜',
      description: '',
      voice: 'sample',
      fileId: null,
    },
  ]
  project.jobs = [
    {
      id: 'video',
      subject: 'opening',
      kind: 'video',
      revision: 1,
      state: 'queued',
      error: null,
      duration: null,
    },
    {
      id: 'voice',
      subject: 'role',
      kind: 'speech',
      purpose: 'voice',
      revision: 1,
      state: 'ready',
      error: null,
      duration: 1000,
    },
  ]
  await page.route('**/api/studio/projects/film', (route) =>
    route.fulfill({ json: project }),
  )
  await page.route('**/api/studio/catalog', (route) =>
    route.fulfill({ json: { configurations: [], defaults: [], agents: [] } }),
  )
  await page.goto('/#/entertainment/film?section=production')
  for (const [label, value] of [
    ['批量文生视频模型', '使用后台默认模型'],
    ['批量参考图模型', '使用后台默认或匹配参考图的模型'],
    ['批量配音模型', '沿用角色音色绑定或后台默认'],
  ]) {
    await expect(
      page.locator('.el-select').filter({ has: page.getByLabel(label!) }),
    ).toContainText(value!)
  }
  const video = page.locator('article').filter({
    has: page.getByRole('heading', {
      name: '动态镜头 · 镜 1 · 海南海边 · 版本 1',
    }),
  })
  await expect(video).toBeVisible()
  await expect(video.getByRole('heading')).not.toContainText(action)
  await expect(video.locator('.expandable-text-preview')).toContainText(action)
  await video.getByRole('button', { name: '展开任务内容', exact: true }).click()
  await expect(
    video.getByRole('button', { name: '收起任务内容', exact: true }),
  ).toHaveAttribute('aria-expanded', 'true')
  const voice = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: /配音.*噜噜.*版本 1/ }) })
  await expect(voice).toBeVisible()
  await expect(voice.getByRole('button', { name: '查看对应镜头' })).toHaveCount(
    0,
  )
  await expect(
    video.getByRole('button', { name: '查看对应镜头' }),
  ).toBeVisible()
})

test('仅办公账号无法直接打开娱乐作品', async ({ page }) => {
  const state = await installFoundationFixture(page, [
    'products.office',
    'sessions.read',
  ])
  state.signedIn = true
  await page.goto('/#/entertainment/film')
  await expect(
    page.getByRole('heading', { name: /今天，想完成什么/ }),
  ).toBeVisible()
})

test('作品目录采用真实电影封面、标题空封面和分页搜索', async ({ page }) => {
  const identity = await installFoundationFixture(page, [
    'products.entertainment',
    'studio.projects.read',
    'studio.projects.write',
    'studio.assets.read',
    'studio.assets.write',
  ])
  identity.signedIn = true
  const entry = {
    id: 'film',
    title: '夜航灯塔',
    shots: 2,
    adopted: 1,
    revision: 3,
    updated: new Date().toISOString(),
    coverJobId: 'ready',
  }
  let grants = 0
  let covered = true
  await page.route(/\/api\/studio\/projects\?/, (route) => {
    const query = new URL(route.request().url()).searchParams.get('search')
    return route.fulfill({
      json: query
        ? { items: [], total: 0 }
        : {
            items: [{ ...entry, coverJobId: covered ? 'ready' : null }],
            total: 1,
          },
    })
  })
  await page.route(
    '**/api/studio/projects/film/media/ready/access',
    (route) => {
      grants++
      return route.fulfill({ json: { ready: true } })
    },
  )
  await page.route('**/api/studio/projects/film/media/ready', (route) =>
    route.fulfill({ status: 204 }),
  )
  await page.goto('/#/entertainment')
  const card = page.getByRole('link', { name: entry.title, exact: true })
  await expect.poll(() => grants).toBe(1)
  const bounds = await card.boundingBox()
  expect(bounds?.width).toBeGreaterThan(600)
  expect(bounds?.width).toBeLessThanOrEqual(911)
  await page.getByLabel('搜索作品名称').fill('找不到')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await expect(page.getByText(/没有匹配的作品/)).toBeVisible()
  covered = false
  await page.getByRole('button', { name: '清除筛选' }).click()
  await expect(card.locator('.project-slate')).toHaveText(entry.title)
  expect(grants).toBe(1)
})

test('跨产品切换可继续编辑、保存工程或明确放弃，子表单草稿留在原作品', async ({
  page,
}) => {
  const identity = await installFoundationFixture(page, [
    'products.entertainment',
    'studio.projects.read',
    'studio.projects.write',
    'studio.assets.read',
    'studio.assets.write',
    'products.office',
  ])
  identity.signedIn = true
  const project = emptyProject()
  await page.route('**/api/studio/projects/film', async (route) => {
    if (route.request().method() === 'PUT') {
      project.document = route.request().postDataJSON().document
      return route.fulfill({ json: { revision: ++project.revision } })
    }
    return route.fulfill({ json: project })
  })
  await page.goto('/#/entertainment/film?section=script')
  const script = page.getByLabel('剧本正文')
  await script.fill('保存版')
  const switcher = page.getByRole('link', { name: '切换产品' })
  const confirm = page.getByRole('dialog', { name: '确认操作' })
  await switcher.click()
  await confirm.getByRole('button', { name: '取消' }).click()
  await expect(script).toHaveValue('保存版')
  await switcher.click()
  await confirm.getByRole('button', { name: '保存并离开' }).click()
  await expect(confirm).toBeHidden()
  await expect(page.getByRole('link', { name: /星桥办公/ })).toBeVisible()
  expect(project.document.script).toBe('保存版')
  await page.goto('/#/entertainment/film?section=library')
  await page.getByRole('button', { name: '添加或引用素材' }).first().click()
  await page.getByLabel('名称', { exact: true }).fill('未提交的草稿')
  await page
    .getByRole('dialog', { name: '项目素材与个人库' })
    .locator('.el-drawer__close-btn')
    .click()
  await switcher.click()
  await expect(
    confirm.getByRole('button', { name: '保存并离开' }),
  ).toBeDisabled()
  await confirm.getByRole('button', { name: '取消' }).click()
  await page.getByRole('button', { name: '添加或引用素材' }).first().click()
  await expect(page.getByLabel('名称', { exact: true })).toHaveValue(
    '未提交的草稿',
  )
  await page
    .getByRole('dialog', { name: '项目素材与个人库' })
    .locator('.el-drawer__close-btn')
    .click()
  await switcher.click()
  await confirm.getByRole('button', { name: '放弃修改' }).click()
  await expect(page.getByRole('link', { name: /星桥办公/ })).toBeVisible()
  expect(project.revision).toBe(2)
})

test('任务中心与作品任务共用安全恢复入口，未知受理不会二次提交', async ({
  page,
}) => {
  const identity = await installFoundationFixture(page, [
    'products.entertainment',
    'studio.projects.read',
    'studio.projects.write',
    'studio.assets.read',
    'studio.assets.write',
    'models.use',
  ])
  identity.signedIn = true
  const project = emptyProject()
  const base = {
    subject: 'shot',
    kind: 'video' as const,
    revision: 1,
    duration: 2000,
    error: null,
  }
  project.jobs = [
    { ...base, id: 'uncertain', state: 'unknown', hasReceipt: false },
    {
      ...base,
      id: 'recover',
      state: 'failed',
      recoveryState: 'polling',
      hasReceipt: true,
    },
  ]
  let calls = 0
  await page.route(/\/api\/studio\/jobs\?/, (route) =>
    route.fulfill({
      json: {
        items: project.jobs.map((j) => ({
          ...j,
          project: project.id,
          projectTitle: project.title,
          updated: project.updated,
        })),
        total: 2,
      },
    }),
  )
  await page.route('**/api/studio/projects/film', (route) =>
    route.fulfill({ json: project }),
  )
  await page.route('**/api/studio/jobs/recover/actions', (route) => {
    calls++
    project.jobs[1]!.state = 'polling'
    return route.fulfill({ json: project.jobs[1] })
  })
  await page.route('**/api/studio/jobs/uncertain/actions', (route) =>
    route.fulfill({ json: [] }),
  )
  await page.goto('/#/entertainment/tasks')
  await page.getByRole('button', { name: '核对任务' }).click()
  const dialog = page.getByRole('dialog', { name: /^核对任务 · / })
  await expect(dialog).toContainText('系统不会自动重发')
  await expect(
    dialog.getByRole('button', { name: '恢复结果查询或下载' }),
  ).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await page.getByRole('link', { name: '查看作品任务' }).first().click()
  await page.getByRole('button', { name: '恢复原任务', exact: true }).click()
  await expect(
    page
      .getByRole('region', { name: '制作任务', exact: true })
      .getByText('生成中', { exact: true }),
  ).toBeVisible()
  expect(calls).toBe(1)
})
