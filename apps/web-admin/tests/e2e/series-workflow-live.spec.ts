import { expect, test, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import type { StudioSeries } from '../../fronted/src/types/studio/series'
import type { StudioProject } from '../../fronted/src/types/studio/studio'

/** 浏览器、API、固定DSH与工具回调真实运行，模型SSE仅由隔离进程提供合成建议。 */
test('系列短剧创建、编排、锁定、单集上下文与结构拆合导入', async ({ page }) => {
  test.skip(process.env.WEB_ADMIN_E2E_LIVE !== '1')
  test.setTimeout(300_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/?isolated-series=' + randomUUID() + '#/login')
  await page
    .getByLabel('用户名或邮箱')
    .fill(process.env.WEB_ADMIN_E2E_USERNAME!)
  await page
    .getByLabel('密码', { exact: true })
    .fill(process.env.WEB_ADMIN_E2E_PASSWORD!)
  const signed = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/auth/login') &&
      response.request().method() === 'POST',
  )
  await page.getByRole('button', { name: '登录 ↵', exact: true }).click()
  const token = (await (await signed).json()).accessToken
  const headers = { authorization: 'Bearer ' + token }
  const connection = await page.request.post('/api/admin/models/connections', {
    headers,
    data: {
      name: '隔离短剧SSE',
      adapter: 'openai-completions',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'synthetic',
    },
  })
  expect(connection.ok(), await connection.text()).toBeTruthy()
  const configuration = await page.request.post(
    '/api/admin/models/configurations',
    {
      headers,
      data: {
        name: '合成编排模型',
        connectionId: (await connection.json()).id,
        capability: 'chat',
        modelId: 'controlled',
        parameters: { maxTokens: 2048 },
      },
    },
  )
  expect(configuration.ok(), await configuration.text()).toBeTruthy()
  expect(
    (
      await page.request.put('/api/admin/models/defaults/chat', {
        headers,
        data: { configurationId: (await configuration.json()).id, revision: 0 },
      })
    ).ok(),
  ).toBeTruthy()

  await page.goto('/#/entertainment')
  await page.getByRole('button', { name: /新建作品/ }).click()
  await page.getByRole('menuitem', { name: /系列短剧/ }).click()
  const createDialog = page.getByRole('dialog', {
    name: '新建系列短剧',
    exact: true,
  })
  await expect(createDialog).toBeVisible()
  await expect(page.getByLabel('主要语言', { exact: true })).toHaveValue(
    'zh-CN',
  )
  await page
    .getByRole('spinbutton', { name: '计划集数', exact: true })
    .fill('2')
  await createDialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(
    page.getByRole('dialog', { name: '未保存的修改', exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: '继续编辑', exact: true }).click()
  await expect(createDialog).toBeVisible()
  await expect(page).toHaveURL(/\/entertainment(?:\?[^#]*)?$/)
  await expect(
    page.getByRole('spinbutton', { name: '计划集数', exact: true }),
  ).toHaveValue('2')
  await page
    .getByLabel('作品名称', { exact: true })
    .fill('隔离系列短剧：穿过四季抵达星河的旅人')
  await page
    .getByLabel('故事构想', { exact: true })
    .fill(
      '两位旅伴从小镇出发，在不同季节寻找同一张星图。每集拥有明确转折，同时保留前情和人物选择。',
    )
  await page
    .getByRole('spinbutton', { name: '计划集数', exact: true })
    .fill('2')
  await page
    .getByRole('button', { name: '创建并编排故事', exact: true })
    .click()
  await expect(page).toHaveURL(
    /\/entertainment\/series\/[a-z0-9]+\?section=episodes/,
  )
  const id = new URL(page.url()).hash.split('/series/')[1]!.split('?')[0]!
  const path = '/api/studio/series/' + id
  const read = async (): Promise<StudioSeries> =>
    (await page.request.get(path, { headers })).json()
  let state = await read()
  expect(state.episodes).toHaveLength(2)
  expect(
    (
      await page.request
        .get('/api/studio/jobs', { headers })
        .then((response) => response.json())
    ).total,
  ).toBe(0)
  const firstId = state.episodes[0]!.id
  await page.getByLabel('本集名称', { exact: true }).fill('星图在雨夜出现')
  await page
    .getByLabel('本集要讲什么', { exact: true })
    .fill(
      '旅人修复一张旧星图，发现约定的地点。' +
        '他们沿河岸寻找故乡留下的记号，必须在涨潮前作出选择。'.repeat(8),
    )
  await page
    .getByLabel('开场', { exact: true })
    .fill('雨夜的车站，一封没有署名的信。')
  await page
    .getByLabel('冲突与转折', { exact: true })
    .fill('星图指向废弃渡口，旅伴对前进的方向发生争执。')
  await page
    .getByLabel('结尾', { exact: true })
    .fill('他们决定沿着河岸继续前行。')
  await page
    .getByLabel('前后集衔接', { exact: true })
    .fill('第二集沿用星图与铜制指南针，不更换人物关系。')
  await page.getByRole('button', { name: '保存草稿', exact: true }).click()
  await expect
    .poll(async () => (await read()).episodes[0]!.title)
    .toBe('星图在雨夜出现')
  const beforeCancel = await read()
  await page.getByLabel('本集名称', { exact: true }).fill('尚未保存的分集名称')
  for (const operation of [
    {
      button: page
        .locator('.series-directory-item')
        .nth(1)
        .getByRole('button', { name: '锁定', exact: true }),
      title: '锁定本集',
    },
    {
      button: page.getByRole('button', { name: '后移第1集', exact: true }),
      title: '调整分集顺序',
    },
    {
      button: page.getByRole('button', { name: '移除本集', exact: true }),
      title: '移除分集',
    },
  ]) {
    await operation.button.click()
    await page
      .getByRole('dialog', { name: operation.title, exact: true })
      .getByRole('button', { name: '取消', exact: true })
      .click()
    await expect(page.getByLabel('本集名称', { exact: true })).toHaveValue(
      '尚未保存的分集名称',
    )
    expect((await read()).revision).toBe(beforeCancel.revision)
    await expect(page.locator('.el-alert--error')).toHaveCount(0)
  }
  await page.getByLabel('本集名称', { exact: true }).fill('星图在雨夜出现')
  await screenshots(page, 'series-story')

  await page
    .getByRole('button', { name: '确认本集并进入制作', exact: true })
    .click()
  state = await read()
  await expect(page).toHaveURL(
    new RegExp('/entertainment/' + state.episodes[0]!.projectId),
  )
  await expect(page.getByLabel('所属短剧')).toBeVisible()
  await expect(
    page.getByRole('combobox', { name: '切换分集', exact: true }),
  ).toBeVisible()
  await screenshots(page, 'series-episode-context')
  state = await read()
  const document = await page.request
    .get('/api/studio/projects/' + state.episodes[0]!.projectId, { headers })
    .then((response) => response.json())
  expect(document.document.script).toContain('雨夜的车站')
  expect(state.episodes[0]!.confirmedStoryRevision).toBe(
    state.episodes[0]!.storyRevision,
  )
  await page.getByRole('link', { name: /整剧总览/ }).click()
  await expect(page).toHaveURL(new RegExp('/entertainment/series/' + id))
  await page.getByRole('link', { name: '故事与分集', exact: true }).click()

  const second = page.locator('.series-directory-item').nth(1)
  await second.getByRole('button', { name: '锁定', exact: true }).click()
  await page
    .getByRole('dialog', { name: '锁定本集', exact: true })
    .getByRole('button', { name: '锁定', exact: true })
    .click()
  await expect.poll(async () => (await read()).episodes[1]!.locked).toBe(true)
  await second.locator('.series-select').click()
  await expect(page.getByLabel('本集名称', { exact: true })).toBeDisabled()
  await page
    .locator('.series-directory-item')
    .first()
    .locator('.series-select')
    .click()
  await page.getByRole('button', { name: 'AI 协助编排', exact: true }).click()
  await page
    .getByRole('combobox', { name: '本次修改范围', exact: true })
    .press('ArrowDown')
  await expect(
    page.getByRole('option', { name: /第2集.*已锁定/ }),
  ).toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Escape')
  await page
    .getByLabel('分集编排要求', { exact: true })
    .fill('只修改第一集梗概和结尾，其他字段保持原样。')
  await page.getByRole('button', { name: '收起 AI 编排', exact: true }).click()
  await page.getByRole('button', { name: 'AI 协助编排', exact: true }).click()
  await expect(page.getByLabel('分集编排要求', { exact: true })).toHaveValue(
    '只修改第一集梗概和结尾，其他字段保持原样。',
  )
  await page.getByRole('button', { name: '生成编排建议', exact: true }).click()
  await expect(
    page.getByLabel('修改建议', { exact: true }).first(),
  ).toBeVisible({ timeout: 90_000 })
  await expect(
    page.getByLabel('修改建议', { exact: true }).first(),
  ).toBeDisabled()
  const proposals = await page.request
    .get(path + '/proposals', { headers })
    .then((response) => response.json())
  expect(
    proposals[0].base.map((item: { episodeId: string }) => item.episodeId),
  ).toEqual([firstId])
  const before = (await read()).episodes[0]!.story
  expect(before.synopsis).not.toContain('月光照亮新线索')
  await screenshots(page, 'series-ai-comparison')
  await page.getByText('星图在雨夜出现 · 结尾', { exact: true }).click()
  await expect(
    page.getByRole('checkbox', { name: '星图在雨夜出现 · 结尾', exact: true }),
  ).not.toBeChecked()
  await page.getByRole('button', { name: '采用所选修改', exact: true }).click()
  await expect
    .poll(async () => (await read()).episodes[0]!.story.synopsis)
    .toContain('月光照亮新线索')
  expect((await read()).episodes[0]!.story.ending).toBe(before.ending)
  await page.getByRole('button', { name: '收起 AI 编排', exact: true }).click()

  await second.getByRole('button', { name: '解锁', exact: true }).click()
  await page
    .getByRole('dialog', { name: '解锁本集', exact: true })
    .getByRole('button', { name: '解锁', exact: true })
    .click()
  await expect.poll(async () => (await read()).episodes[1]!.locked).toBe(false)
  await page.getByRole('button', { name: '拆分故事', exact: true }).click()
  const split = page.getByRole('dialog', { name: '拆分故事', exact: true })
  await split.getByLabel('新分集1名称').fill('星图上篇')
  await split.getByLabel('新分集2名称').fill('星图下篇')
  await split
    .getByLabel('新分集2故事')
    .fill('旅伴抵达渡口，发现信件真正的寄送者。')
  await split.getByRole('button', { name: '预览调整方案', exact: true }).click()
  await expect(
    split.getByText('将保留为只读历史的原集', { exact: true }),
  ).toBeVisible()
  expect((await read()).episodes).toHaveLength(2)
  await split
    .getByRole('button', { name: '确认调整分集结构', exact: true })
    .click()
  await expect(split).not.toBeVisible()
  await expect.poll(async () => (await read()).episodes.length).toBe(3)
  expect((await read()).archivedEpisodes).toHaveLength(1)
  await page.getByRole('button', { name: '合并故事', exact: true }).click()
  const merge = page.getByRole('dialog', { name: '合并故事', exact: true })
  await merge
    .getByRole('combobox', { name: '要合并的分集', exact: true })
    .press('ArrowDown')
  await page
    .getByRole('option', { name: '第2集 · 星图下篇', exact: true })
    .click()
  await page.keyboard.press('Escape')
  await merge.getByRole('button', { name: '预览调整方案', exact: true }).click()
  await expect(
    merge.getByText('将保留为只读历史的原集', { exact: true }),
  ).toBeVisible()
  await merge
    .getByRole('button', { name: '确认调整分集结构', exact: true })
    .click()
  await expect(merge).not.toBeVisible()
  await expect.poll(async () => (await read()).episodes.length).toBe(2)

  const standalone = await page.request.post('/api/studio/projects', {
    headers,
    data: { title: '可加入的既有分镜作品' },
  })
  expect(standalone.ok(), await standalone.text()).toBeTruthy()
  const standaloneId = (await standalone.json()).id
  const saved = await page.request.put('/api/studio/projects/' + standaloneId, {
    headers,
    data: {
      revision: 1,
      document: {
        script: '既有作品正文，不因加入短剧丢失。',
        shots: [{ id: 'existing-shot', action: '保留既有镜头' }],
      },
    },
  })
  expect(saved.ok(), await saved.text()).toBeTruthy()
  await page
    .getByRole('button', { name: '从已有作品加入', exact: true })
    .click()
  const importer = page.getByRole('dialog', {
    name: '从已有作品加入一集',
    exact: true,
  })
  await importer.getByText(/^可加入的既有分镜作品 ·/).click()
  await importer.getByRole('button', { name: '加入本剧', exact: true }).click()
  await expect(importer).not.toBeVisible()
  await expect.poll(async () => (await read()).episodes.length).toBe(3)
  expect(
    (await read()).episodes.some(
      (episode) => episode.projectId === standaloneId && episode.shots === 1,
    ),
  ).toBeTruthy()
  await page.getByRole('link', { name: '整剧总览', exact: true }).click()
  await screenshots(page, 'series-overview')
  const asset = await page.request.post('/api/studio/assets', {
    headers,
    data: {
      name: '旅伴 · 铜色指南针',
      kind: 'prop',
      description: '历经风雨的铜色指南针，外壳刻有共同的星图记号。',
    },
  })
  expect(asset.ok(), await asset.text()).toBeTruthy()
  const assetId = (await asset.json()).id
  await page.getByRole('link', { name: '本剧设定', exact: true }).click()
  await page
    .getByRole('button', { name: '从素材库选择角色、场景与道具', exact: true })
    .click()
  const picker = page.getByRole('dialog', {
    name: '选择本剧共用设定',
    exact: true,
  })
  await picker.getByRole('button', { name: '选择', exact: true }).click()
  await picker
    .getByRole('button', { name: '使用所选素材', exact: true })
    .click()
  await expect(picker).not.toBeVisible()
  await page.getByRole('button', { name: '保存本剧设定', exact: true }).click()
  await expect
    .poll(async () => (await read()).settings.map((item) => item.id))
    .toEqual([assetId])
  const beforeSettingsApply = await read()
  await page
    .locator('.series-setting-row')
    .first()
    .getByText(/^第1集/)
    .click()
  await page.getByRole('button', { name: '同步所选分集', exact: true }).click()
  await page
    .getByRole('dialog', { name: '确认更新范围', exact: true })
    .getByRole('button', { name: '同步所选分集', exact: true })
    .click()
  await expect
    .poll(async () => (await read()).episodes[0]!.settingsRevision)
    .toBe((await read()).settingsRevision)
  expect(
    (await read()).episodes.slice(1).map((episode) => episode.settingsRevision),
  ).toEqual(
    beforeSettingsApply.episodes
      .slice(1)
      .map((episode) => episode.settingsRevision),
  )
  const settingsProject: StudioProject = await page.request
    .get('/api/studio/projects/' + (await read()).episodes[0]!.projectId, {
      headers,
    })
    .then((response) => response.json())
  const projectAsset = settingsProject.assets.find(
    (item) => item.parent === assetId,
  )
  expect(projectAsset?.name).toBe('旅伴 · 铜色指南针')
  expect(settingsProject.document.assets).toContain(projectAsset!.id)
  await screenshots(page, 'series-settings')
  await page.getByRole('link', { name: '剧集制作', exact: true }).click()
  await expect(
    page.getByRole('link', { name: '进入单集制作 →', exact: true }),
  ).toHaveCount(3)
  await screenshots(page, 'series-production')
  await page
    .getByRole('navigation', { name: '整剧工作区', exact: true })
    .getByRole('link', { name: '成片交付', exact: true })
    .click()
  await expect(
    page.getByText(
      '还没有可交付的成片。进入单集完成剪辑并导出后，会在这里汇总。',
      { exact: true },
    ),
  ).toBeVisible()
  await screenshots(page, 'series-delivery')
  expect(
    (
      await page.request
        .get('/api/studio/jobs', { headers })
        .then((response) => response.json())
    ).total,
  ).toBe(0)
  expect(errors).toEqual([])
})

/** 检查真实布局、同排面板边界和正文滚动后标题位置，保留四宽度×双主题证据。 */
async function screenshots(page: Page, prefix: string) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate(
      (value) =>
        document.documentElement.classList.toggle('dark', value === 'dark'),
      theme,
    )
    for (const width of [390, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: 1000 })
      await page.locator('[data-console-content]').evaluate((element) => {
        element.scrollTop = 0
      })
      await page.evaluate(() => window.scrollTo(0, 0))
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        )
        .toBeTruthy()
      const navigation = page.getByRole('navigation', {
        name: '整剧工作区',
        exact: true,
      })
      if (await navigation.count())
        await expect
          .poll(() =>
            navigation.evaluate((element) => {
              const active = element
                .querySelector('[aria-current="page"]')!
                .getBoundingClientRect()
              const container = element.getBoundingClientRect()
              return (
                active.left >= container.left - 1 &&
                active.right <= container.right + 1
              )
            }),
          )
          .toBeTruthy()
      const panels = page.locator('.series-planning > .series-panel')
      if (width >= 1280) {
        const positions = await panels.evaluateAll((elements) =>
          elements.map((element) => {
            const bounds = element.getBoundingClientRect()
            return { top: bounds.top, bottom: bounds.bottom }
          }),
        )
        for (const panel of positions)
          for (const sibling of positions)
            if (Math.abs(panel.top - sibling.top) < 1)
              expect(
                Math.abs(panel.bottom - sibling.bottom),
              ).toBeLessThanOrEqual(1)
      }
      const headerPositions = await panels
        .locator('.scroll-panel__header')
        .evaluateAll((elements) =>
          elements.map((element) => element.getBoundingClientRect().top),
        )
      await page.screenshot({
        path:
          process.env.WEB_ADMIN_VALIDATION_DIR +
          '/' +
          prefix +
          '-' +
          theme +
          '-' +
          width +
          '.png',
        fullPage: true,
      })
      const bodies = page.locator('.series-panel .scroll-panel__body')
      for (let index = 0; index < (await bodies.count()); index++) {
        const body = bodies.nth(index)
        await body.evaluate((element) => {
          element.scrollTop = element.scrollHeight
        })
      }
      expect(
        await panels
          .locator('.scroll-panel__header')
          .evaluateAll((elements) =>
            elements.map((element) => element.getBoundingClientRect().top),
          ),
      ).toEqual(headerPositions)
      if (['series-story', 'series-ai-comparison'].includes(prefix)) {
        await page.screenshot({
          path:
            process.env.WEB_ADMIN_VALIDATION_DIR +
            '/' +
            prefix +
            '-' +
            theme +
            '-' +
            width +
            '-bottom.png',
          fullPage: true,
        })
        // 窄屏中 AI 位于故事后方；独立捕获真实滚动面板，不能只检查首屏。
        if (prefix === 'series-ai-comparison')
          await page.locator('.series-assistant').screenshot({
            path:
              process.env.WEB_ADMIN_VALIDATION_DIR +
              '/' +
              prefix +
              '-panel-' +
              theme +
              '-' +
              width +
              '-bottom.png',
          })
        for (let index = 0; index < (await bodies.count()); index++)
          await bodies.nth(index).evaluate((element) => {
            element.scrollTop = 0
          })
        if (prefix === 'series-ai-comparison')
          await page.locator('.series-assistant').screenshot({
            path:
              process.env.WEB_ADMIN_VALIDATION_DIR +
              '/' +
              prefix +
              '-panel-' +
              theme +
              '-' +
              width +
              '.png',
          })
      }
    }
  }
  await page.evaluate(() => document.documentElement.classList.remove('dark'))
  await page.setViewportSize({ width: 1440, height: 1000 })
}
