import { expect, test, type Page, type Locator } from '@playwright/test'
import { installFoundationFixture } from './foundation-fixture'
import { studioProposalFixture } from '../fixtures/studio-proposal'
import { captureDesign } from './design-capture'

/** 合成长正文、多候选与音频数据只存在于浏览器上下文，不连接用户数据库或收费模型。 */
async function fixture(page: Page) {
  const state = await installFoundationFixture(page, [
    'products.entertainment',
    'studio.projects.read',
    'studio.projects.write',
    'studio.assets.read',
    'studio.assets.write',
    'models.use',
    'files.read',
    'files.write',
    'sessions.read',
    'sessions.run',
  ])
  state.signedIn = true
  const { project, shot, roleId, sceneId } = studioProposalFixture()
  project.proposal = null
  project.aspectWidth = 9
  project.aspectHeight = 16
  project.brief = '主角第一次去海边，沿着椰林旅行。'.repeat(12)
  project.styleBrief = '温暖明亮的动画，自然光与柔和的海风。'
  project.document.scenes = [
    {
      id: sceneId,
      title: '椰林海滩',
      synopsis: '走过椰林，拾起椰子，在夕阳里挥手。',
    },
  ]
  project.document.shots = Array.from({ length: 4 }, (_, index) => ({
    ...structuredClone(shot),
    id: 'shot-' + index,
    candidate: 'video-' + index,
    action:
      '竖屏全景，微风吹动椰影，主角沿着海岸向前走，远处是金色的夕阳。'.repeat(
        12,
      ),
    lines: [
      {
        ...shot.lines[0]!,
        id: 'line-' + index,
        text: '海风吹来，主角慢慢向前走，望向远处的灯塔。'.repeat(6),
        audio: 'voice-' + index,
      },
    ],
  }))
  project.assets[0]!.description =
    '### 角色设定\n奶黄色的小动物，穿着橙色短裤，向海边走去。\n'.repeat(6)
  project.assets[0]!.voicePreviewJob = 'voice-0'
  project.assets[0]!.voice = 'synthetic-voice'
  project.jobs = project.document.shots.flatMap((item, index) => [
    {
      id: 'video-' + index,
      subject: item.id,
      kind: 'video' as const,
      state: 'ready',
      revision: 3,
      duration: 5000,
      error: null,
    },
    {
      id: 'voice-' + index,
      subject: 'line-' + index,
      kind: 'speech' as const,
      state: 'ready',
      revision: 3,
      duration: 4000,
      error: null,
    },
  ])
  project.jobs.push({ ...project.jobs[0]!, id: 'alternative' })
  const writes: string[] = []
  await page.route('**/api/studio/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/access'))
      return route.fulfill({ json: { ready: true } })
    if (path.includes('/personal-media/'))
      return route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="480"><rect width="360" height="480" fill="#ddd4c7"/><text x="180" y="240" text-anchor="middle" fill="#4b4036">Synthetic reference</text></svg>',
      })
    if (path.includes('/media/')) return route.fulfill({ status: 204 })
    if (route.request().method() !== 'GET') {
      writes.push(path)
      return route.fulfill({ status: 405, json: { detail: '布局检查不写入' } })
    }
    if (path.endsWith('/preparation'))
      return route.fulfill({ json: { revision: 3, stages: [] } })
    if (path.endsWith('/catalog'))
      return route.fulfill({
        json: { configurations: [], defaults: [], agents: [] },
      })
    if (path.endsWith('/assets')) return route.fulfill({ json: [] })
    if (path.endsWith('/text-edits')) return route.fulfill({ json: [] })
    if (path.endsWith('/projects/' + project.id))
      return route.fulfill({ json: project })
    return route.fallback()
  })
  return { project, roleId, writes }
}

/** 实际滚动正文后，标题仍留在面板顶端；不以 CSS 属性设置代替行为验收。 */
async function expectFixedPanel(body: Locator) {
  await body.press('End')
  await expect
    .poll(() => body.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0)
  const geometry = await body.evaluate((element) => {
    const panel = element.parentElement!
    const header = panel.querySelector('.scroll-panel__header')!
    const panelBox = panel.getBoundingClientRect()
    const headerBox = header.getBoundingClientRect()
    return {
      headerOffset: headerBox.top - panelBox.top,
      bodyTop: element.getBoundingClientRect().top,
      headerBottom: headerBox.bottom,
      width: getComputedStyle(element, '::-webkit-scrollbar').width,
      arrows: getComputedStyle(element, '::-webkit-scrollbar-button').display,
    }
  })
  expect(Math.abs(geometry.headerOffset)).toBeLessThanOrEqual(1)
  expect(geometry.bodyTop).toBeGreaterThanOrEqual(geometry.headerBottom - 1)
  expect(Number.parseFloat(geometry.width)).toBeLessThanOrEqual(8)
  expect(geometry.arrows).toBe('none')
}
for (const theme of ['light', 'dark']) {
  test(`制作弹窗 ${theme}：长候选、预检与 AI 修改底栏`, async ({ page }) => {
    test.setTimeout(120_000)
    await page.addInitScript(
      (value) => localStorage.setItem('starbridge.theme', value),
      theme,
    )
    const { project, writes } = await fixture(page)
    const original =
      '主角在椰林与海边散步，风吹过树梢，浪花缓缓涌上沙滩。'.repeat(40)
    await page.route('**/api/studio/projects/*/text-edits', (route) =>
      route.fulfill({
        json: [
          {
            id: 'text-review',
            scope: 'scene',
            label: '海滩散步',
            original,
            suggestion: original,
            instruction: '对白更轻松，保留角色造型。',
            state: 'ready',
            revision: 3,
            conflict: null,
          },
        ],
      }),
    )
    await page.goto(`/#/entertainment/${project.id}?section=script`)
    await page.getByRole('button', { name: 'AI 修改记录', exact: true }).click()
    const ai = page.getByRole('dialog', { name: 'AI 剧本编辑', exact: true })
    await ai.getByRole('button', { name: /海滩散步.*对白更轻松/ }).click()
    for (const width of [390, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: 844 })
      await expect(
        ai.getByRole('button', { name: '采用并保存', exact: true }),
      ).toBeInViewport()
      expect(
        await ai.evaluate(
          (element) => element.scrollWidth <= element.clientWidth + 1,
        ),
      ).toBe(true)
      await captureDesign(page, `process-ai-${theme}-${width}.png`)
    }
    await ai.locator('.el-drawer__close-btn').click()

    const asset = {
      ...project.assets[0]!,
      id: 'personal-role',
      family: 'personal-family',
      project: null,
      workId: null,
      workTitle: null,
      version: 1,
      sourceJob: 'personal-image-0',
      fileId: null,
    }
    await page.route('**/api/studio/library?**', (route) =>
      route.fulfill({
        json: { items: [asset], total: 1, page: 1, pageSize: 20 },
      }),
    )
    await page.route(
      '**/api/studio/entities/personal-family/production',
      (route) =>
        route.fulfill({
          json: {
            revision: 1,
            asset,
            jobs: Array.from({ length: 12 }, (_, i) => ({
              id: `personal-image-${i}`,
              kind: 'image',
              state: i === 0 ? 'ready' : 'failed',
              revision: 1,
              subject: asset.id,
              error: i ? '测试供应商返回较长的诊断信息。'.repeat(30) : null,
            })),
          },
        }),
    )
    let checked = 0
    await page.route(
      '**/api/studio/entities/personal-family/generation-plans',
      (route) => {
        checked++
        return route.fulfill({
          json: {
            id: 'synthetic-plan',
            revision: 1,
            planHash: 'synthetic-hash',
            state: 'draft',
            items: [
              {
                target: 'a',
                kind: 'image',
                label: original,
                status: 'missing',
                selected: true,
                model: '测试参考图模型',
              },
              {
                target: 'b',
                kind: 'image',
                label: original,
                status: 'ready',
                selected: false,
                model: '测试参考图模型',
              },
            ],
            issues: [],
          },
        })
      },
    )
    await page.goto('/#/entertainment/characters')
    await page.getByRole('button', { name: '制作素材', exact: true }).click()
    const personal = page.getByRole('dialog', {
      name: '个人素材制作',
      exact: true,
    })
    await expect(
      personal.getByRole('button', { name: '当前已采用', exact: true }),
    ).toBeDisabled()
    await expect(
      personal.getByRole('navigation', { name: '列表分页' }),
    ).toContainText('12')
    await personal.getByRole('button', { name: '下一页', exact: true }).click()
    await expect(
      personal.getByRole('navigation', { name: '列表分页' }),
    ).toContainText('11–12')
    await expect(personal.locator('article')).toHaveCount(2)
    await personal.getByRole('button', { name: '上一页', exact: true }).click()
    for (const width of [390, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: 844 })
      await expect(
        personal.getByRole('button', { name: '检查生成方案', exact: true }),
      ).toBeInViewport()
      expect(
        await personal.evaluate(
          (element) => element.scrollWidth <= element.clientWidth + 1,
        ),
      ).toBe(true)
      await captureDesign(page, `process-personal-${theme}-${width}.png`)
    }
    await personal
      .getByRole('button', { name: '检查生成方案', exact: true })
      .click()
    const plan = page.getByRole('dialog', { name: '制作前检查', exact: true })
    await expect(plan.getByText('本次提交 · 1', { exact: true })).toBeVisible()
    await expect(
      plan.locator('details').filter({ hasText: '已跳过，不重复生成' }),
    ).not.toHaveAttribute('open')
    for (const width of [390, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: 844 })
      await expect(
        plan.getByRole('button', { name: '确认用量并提交', exact: true }),
      ).toBeInViewport()
      expect(
        await plan.evaluate(
          (element) => element.scrollWidth <= element.clientWidth + 1,
        ),
      ).toBe(true)
      await captureDesign(page, `process-preflight-${theme}-${width}.png`)
    }
    await plan.getByRole('button', { name: '取消', exact: true }).click()
    expect(checked).toBe(1)
    // 短屏长错误不能挤走操作区，失败和放弃关闭均保留用户尚未提交的输入。
    await page.route(
      '**/api/studio/entities/personal-family/generation-plans',
      (route) =>
        route.fulfill({
          status: 503,
          json: { detail: '测试服务暂不可用。'.repeat(90) },
        }),
    )
    await page.setViewportSize({ width: 390, height: 640 })
    await personal.getByLabel('补充画面要求').fill('保留这份草稿')
    await personal
      .getByRole('button', { name: '检查生成方案', exact: true })
      .click()
    await expect(
      personal.getByRole('button', {
        name: '操作未完成，查看错误',
        exact: true,
      }),
    ).toBeInViewport()
    await expect(
      personal.getByRole('button', { name: '检查生成方案', exact: true }),
    ).toBeInViewport()
    await personal
      .getByRole('button', { name: '操作未完成，查看错误', exact: true })
      .click()
    await captureDesign(page, `process-error-${theme}-390.png`)
    await personal.getByRole('button', { name: '取消', exact: true }).click()
    const guard = page.getByRole('dialog', {
      name: '未保存的修改',
      exact: true,
    })
    await guard.getByRole('button', { name: '继续编辑', exact: true }).click()
    await expect(personal.getByLabel('补充画面要求')).toHaveValue(
      '保留这份草稿',
    )
    expect(writes).toEqual([])
  })
}

for (const theme of ['light', 'dark'])
  for (const width of [390, 768, 1280, 1440]) {
    test(`制作长内容 ${theme} ${width}：八步骤与镜头抽屉`, async ({ page }) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.addInitScript(
        (value) => localStorage.setItem('starbridge.theme', value),
        theme,
      )
      const { project, writes } = await fixture(page)
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      for (const section of [
        'brief',
        'script',
        'cast',
        'storyboard',
        'sample',
        'production',
        'edit',
        'delivery',
      ]) {
        await page.goto(`/#/entertainment/${project.id}?section=${section}`)
        await expect(
          page.getByRole('heading', { name: project.title, exact: true }),
        ).toBeVisible()
        await expect(page.locator('html')).toHaveClass(
          theme === 'dark' ? /dark/ : /^(?!.*dark)/,
        )
        const nav = page.getByRole('navigation', { name: '作品工作区' })
        await expect
          .poll(() =>
            nav.evaluate((element) => {
              const current = element
                .querySelector('[aria-current="page"]')!
                .getBoundingClientRect()
              const bounds = element.getBoundingClientRect()
              return (
                current.left >= bounds.left - 1 &&
                current.right <= bounds.right + 1
              )
            }),
          )
          .toBe(true)
        if (section === 'storyboard') {
          const cards = page.locator('.studio-rail .studio-shot')
          await expect(cards).toHaveCount(4)
          expect(
            await cards
              .first()
              .evaluate((element) => element.getBoundingClientRect().height),
          ).toBeLessThan(260)
          expect(
            await page
              .locator('.studio-rail-label')
              .first()
              .evaluate((element) => element.getBoundingClientRect().width),
          ).toBeGreaterThan(100)
          const monitor = page.getByRole('region', { name: '镜头预览与候选' })
          if (width >= 1280) {
            // 多栏上下边缘严格对齐，不能仅限制 max-height 后任由内容决定栏高。
            const boxes = await page
              .locator('.studio-board')
              .evaluate((element) =>
                [...element.children].map((child) => {
                  const box = child.getBoundingClientRect()
                  return {
                    top: box.top,
                    bottom: box.bottom,
                    height: box.height,
                  }
                }),
              )
            expect(boxes.length).toBe(width === 1440 ? 3 : 2)
            expect(
              Math.max(...boxes.map((box) => box.top)) -
                Math.min(...boxes.map((box) => box.top)),
            ).toBeLessThanOrEqual(1)
            expect(
              Math.max(...boxes.map((box) => box.bottom)) -
                Math.min(...boxes.map((box) => box.bottom)),
            ).toBeLessThanOrEqual(1)
            const takeBounds = await monitor
              .getByRole('button', { name: '时间线已采用', exact: true })
              .boundingBox()
            expect(takeBounds!.y + takeBounds!.height).toBeLessThanOrEqual(
              boxes[0]!.bottom,
            )
            const rail = page.getByRole('region', {
              name: '分镜目录内容',
              exact: true,
            })
            await expectFixedPanel(rail)
            if (width === 1440) {
              const inspector = page.getByRole('region', {
                name: '镜头设定内容',
                exact: true,
              })
              await expectFixedPanel(inspector)
              await expect(
                page.getByRole('tab', { name: '画面', exact: true }),
              ).toBeInViewport()
              await expect(
                page.getByRole('button', { name: '生成此镜候选', exact: true }),
              ).toBeInViewport()
              await inspector.press('Home')
            }
          }
          await monitor
            .getByRole('button', { name: '对比候选', exact: true })
            .click()
          await expect(monitor.locator('video[controls]')).toHaveCount(2)
          await monitor
            .getByRole('button', { name: '退出对比', exact: true })
            .click()
          const entry = page.getByRole('button', {
            name: '镜头设定',
            exact: true,
          })
          if (width < 1440) {
            await entry.click()
            const drawer = page.getByRole('dialog', {
              name: '镜头设定',
              exact: true,
            })
            await expectFixedPanel(
              drawer.getByRole('region', { name: '镜头设定内容', exact: true }),
            )
            await drawer.getByRole('tab', { name: '台词', exact: true }).click()
            await expect(
              drawer.getByRole('heading', { name: '角色台词', exact: true }),
            ).toBeInViewport()
            await expect(
              drawer.getByRole('heading', { name: '镜头设定', exact: true }),
            ).toHaveCount(1)
            await expect
              .poll(() =>
                drawer
                  .getByRole('region', { name: '镜头设定内容', exact: true })
                  .evaluate((element) => element.scrollTop),
              )
              .toBe(0)
            await expect(
              drawer.getByRole('textbox', { name: '台词', exact: true }),
            ).toBeVisible()
            await expect(
              drawer.getByRole('button', { name: '返回审看' }),
            ).toBeInViewport()
            await captureDesign(page, `process-inspector-${theme}-${width}.png`)
            await drawer.getByRole('button', { name: '返回审看' }).click()
          }
        }
        if (section === 'cast') {
          await expect(page.locator('.cast-card audio')).toHaveCount(1)
          expect(
            await page
              .locator('.cast-card audio')
              .evaluate(
                (element) =>
                  element.getBoundingClientRect().width <=
                  element.parentElement!.getBoundingClientRect().width + 1,
              ),
          ).toBe(true)
        }
        if (section === 'production') {
          await page.getByText('自选镜头与台词', { exact: true }).click()
          await expect(page.locator('.selection-option')).toHaveCount(8)
          const description = page
            .locator('.selection-option .expandable-text p')
            .first()
          expect(
            await description.evaluate((element) =>
              Number.parseFloat(getComputedStyle(element).fontSize),
            ),
          ).toBeGreaterThanOrEqual(14)
          expect(
            await description.evaluate(
              (element) => element.getBoundingClientRect().height,
            ),
          ).toBeGreaterThan(24)
          await page
            .getByRole('region', { name: '批量制作范围' })
            .getByText('镜 1 · 晴天海滩', { exact: true })
            .click()
          await expect(
            page.getByRole('checkbox', {
              name: '镜 1 · 晴天海滩',
              exact: true,
            }),
          ).toBeChecked()
          expect(
            await page
              .locator('.selection-option')
              .first()
              .evaluate(
                (element) => element.scrollWidth <= element.clientWidth + 1,
              ),
          ).toBe(true)
        }
        if (section === 'edit') {
          await expect(page.getByLabel('时间线缩放')).toBeVisible()
          await page.getByRole('button', { name: /字幕 · 镜 1/ }).click()
          await expect(
            page.getByLabel('字幕', { exact: true }).first(),
          ).toBeVisible()
        }
        if (section === 'delivery')
          await expect(
            page.getByText('尚未导出成片，完成剪辑后可导出当前工程。'),
          ).toBeVisible()
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        ).toBe(true)
        await page
          .getByRole('heading', { name: project.title, exact: true })
          .scrollIntoViewIfNeeded()
        await captureDesign(page, `process-${section}-${theme}-${width}.png`)
      }
      expect(writes).toEqual([])
      expect(errors).toEqual([])
    })
  }
