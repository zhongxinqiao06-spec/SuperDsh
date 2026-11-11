import { expect, test, type Locator, type Page } from '@playwright/test'
import { installResourceFixture } from '../parity/resource-fixture'
import { installParityFixture } from '../parity/ui-fixture'
import { consoleModules } from '../../fronted/src/utils/console/modules'
import type {
  AgentDefinition,
  AgentDraft,
} from '../../fronted/src/types/agents/agents'

/** 视觉与交互使用独立合成传输；不创建真实账号、执行任务或调用外部模型。 */
async function installEditorFixture(page: Page) {
  await installResourceFixture(page)
  let agent: AgentDefinition = {
    id: 'filled-agent',
    name: '企业资料助手',
    description: '基于授权资料检索、整理与生成内容，交付有依据且可编辑的成果。',
    instructions: '明确目标、读者和资料范围，缺失依据时先询问。\n'.repeat(30),
    recommendedPrompts: ['整理本周经营资料，先给出提纲。'],
    inputRequirements: ['上传授权的资料。'],
    outputExamples: ['可编辑的报告和引用清单。'],
    knowledgeBaseIds: ['filled-knowledge'],
    knowledgeAssetIds: [],
    templateAssetIds: [],
    skillIds: [],
    toolIds: [],
    published: true,
    version: 4,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
  }
  const state = { writes: [] as AgentDraft[], reject: true }
  await page.route(
    (url) =>
      ['/api/admin/agents', '/api/admin/agents/filled-agent'].includes(
        url.pathname,
      ),
    async (route) => {
      if (route.request().method() === 'GET')
        return route.fulfill({
          json: { items: [agent], total: 1, page: 1, pageSize: 10 },
        })
      if (route.request().method() === 'PUT') {
        const value = route.request().postDataJSON() as AgentDraft
        state.writes.push(value)
        if (state.reject)
          return route.fulfill({
            status: 409,
            json: { detail: '合成保存冲突，请核对后重试' },
          })
        agent = { ...agent, ...value, version: agent.version + 1 }
        return route.fulfill({ json: { agent } })
      }
      return route.fulfill({
        status: 405,
        json: { detail: '本次展示验证不支持该操作' },
      })
    },
  )
  return state
}

async function expectVisibleFooter(dialog: Locator, page: Page) {
  const bounds = await dialog.locator('.el-dialog__footer').boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.y).toBeGreaterThanOrEqual(0)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(
    page.viewportSize()!.height + 1,
  )
  await expect(dialog.locator('.el-dialog')).toHaveCSS('overflow-y', 'hidden')
}

for (const theme of ['light', 'dark']) {
  test(`统一编辑器 ${theme}：分区、校验定位、关联、失败草稿和确认关闭`, async ({
    page,
  }, info) => {
    await page.addInitScript(
      (value) => localStorage.setItem('starbridge.theme', value),
      theme,
    )
    const state = await installEditorFixture(page)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('/#/agents')
    await expect(
      page.getByRole('heading', { level: 1, name: '智能体列表' }),
    ).toBeVisible()
    await page.screenshot({
      path: info.outputPath(`agents-${theme}.png`),
      animations: 'disabled',
    })
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '编辑智能体', exact: true })
    await expectVisibleFooter(dialog, page)
    await dialog.getByRole('tab', { name: '行为规范', exact: true }).click()
    const instructions = dialog.getByRole('textbox', {
      name: '工作要求',
      exact: true,
    })
    expect((await instructions.boundingBox())!.height).toBeGreaterThan(160)
    await page.screenshot({
      path: info.outputPath(`agent-instructions-${theme}.png`),
      animations: 'disabled',
    })
    await instructions.fill('')
    await dialog.getByRole('tab', { name: '基本信息', exact: true }).click()
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(
      dialog.getByRole('tab', { name: '行为规范', exact: true }),
    ).toHaveAttribute('aria-selected', 'true')
    await expect(instructions).toBeFocused()
    expect(state.writes).toHaveLength(0)
    await instructions.fill('仅依据授权资料回答，缺失信息先询问。')
    await expect(dialog.locator('.field-error')).toHaveCount(0)
    await expect(dialog.locator('.dialog-error')).toHaveCount(0)
    await dialog.getByRole('button', { name: '展开编辑', exact: true }).click()
    const expanded = page.getByRole('dialog', { name: '工作要求', exact: true })
    await expanded
      .getByRole('textbox', { name: '工作要求' })
      .fill('展开编辑后仍保留原草稿。')
    await expanded.getByRole('button', { name: '完成编辑' }).click()
    await expect(instructions).toHaveValue('展开编辑后仍保留原草稿。')
    await dialog.getByRole('tab', { name: '资源关联', exact: true }).click()
    await dialog.getByRole('tab', { name: /业务技能/ }).click()
    await dialog.getByRole('checkbox', { name: /合成阶段技能/ }).check()
    await dialog.getByRole('tab', { name: /可用工具/ }).click()
    await expect(
      dialog.getByRole('checkbox', { name: /合成依赖工具/ }),
    ).toBeChecked()
    await dialog.getByRole('textbox', { name: '搜索可用工具' }).fill('不存在')
    await expect(
      dialog.getByText('没有匹配的资源。', { exact: true }),
    ).toBeVisible()
    await dialog.getByRole('textbox', { name: '搜索可用工具' }).fill('')
    await page.screenshot({
      path: info.outputPath(`agent-resources-${theme}.png`),
      animations: 'disabled',
    })
    await dialog.getByRole('tab', { name: '示例与发布', exact: true }).click()
    await dialog
      .getByRole('button', { name: '＋ 添加一项', exact: true })
      .first()
      .click()
    await dialog
      .getByRole('textbox', { name: '推荐指令 2', exact: true })
      .fill('  第二项示例  ')
    await expectVisibleFooter(dialog, page)
    await page.screenshot({
      path: info.outputPath(`agent-examples-${theme}.png`),
      animations: 'disabled',
    })
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: '继续编辑', exact: true }).click()
    await expect(
      dialog.getByRole('textbox', { name: '推荐指令 2', exact: true }),
    ).toHaveValue('  第二项示例  ')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(
      dialog.getByText('合成保存冲突，请核对后重试', { exact: true }),
    ).toBeVisible()
    await expectVisibleFooter(dialog, page)
    state.reject = false
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(dialog).toBeHidden()
    expect(state.writes).toHaveLength(2)
    expect(state.writes[1]).toMatchObject({
      instructions: '展开编辑后仍保留原草稿。',
      skillIds: ['filled-skill'],
      toolIds: ['required-tool'],
      recommendedPrompts: ['整理本周经营资料，先给出提纲。', '第二项示例'],
    })
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    await dialog
      .getByRole('textbox', { name: '名称', exact: true })
      .fill('放弃的修改')
    await dialog
      .getByRole('button', { name: '关闭此对话框', exact: true })
      .click()
    await page.getByRole('button', { name: '放弃修改', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(
      page.getByRole('button', { name: '编辑', exact: true }),
    ).toBeFocused()
    expect(state.writes).toHaveLength(2)
    expect(errors).toEqual([])
  })
}

test('窄屏管理卡片与全屏编辑：常用操作可见、底栏固定、草稿跨分区保留', async ({
  page,
}, info) => {
  await installEditorFixture(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#/agents')
  await expect(page.locator('.resource-card')).toBeVisible()
  await expect(
    page.getByRole('button', { name: '试用', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: '更多操作', exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: '发布检查', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: '取消发布', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: '删除', exact: true }),
  ).toBeVisible()
  await page.screenshot({
    path: info.outputPath('agents-mobile.png'),
    animations: 'disabled',
  })
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '编辑智能体', exact: true })
  await expect(dialog.locator('.el-dialog')).toHaveCSS('width', '390px')
  await expectVisibleFooter(dialog, page)
  await dialog
    .getByRole('textbox', { name: '名称', exact: true })
    .fill('窄屏草稿')
  await dialog.getByRole('tab', { name: '行为规范', exact: true }).click()
  await expectVisibleFooter(dialog, page)
  await page.screenshot({
    path: info.outputPath('agent-editor-mobile.png'),
    animations: 'disabled',
  })
  await dialog.getByRole('tab', { name: '基本信息', exact: true }).click()
  await expect(
    dialog.getByRole('textbox', { name: '名称', exact: true }),
  ).toHaveValue('窄屏草稿')
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
})

for (const theme of ['light', 'dark']) {
  test(`全站视觉边界 ${theme}：管理路由、四档宽度与单一页面标题`, async ({
    page,
  }, info) => {
    test.setTimeout(120_000)
    await page.addInitScript(
      (value) => localStorage.setItem('starbridge.theme', value),
      theme,
    )
    const state = await installParityFixture(page)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.routeWebSocket('**/api/**', () => {})
    const headings: Record<string, string> = {
      overview: '看板',
      'account.profile': '个人资料',
      'account.appearance': '外观与语言',
      'system.service': '服务',
    }
    for (const module of consoleModules) {
      await page.goto(`/#${module.path}`)
      await expect(page.locator('.console-content')).toBeVisible()
      if (module.id !== 'workbench') {
        await expect(page.locator('.console-content h1')).toHaveText(
          headings[module.id] ?? module.title,
        )
      } else {
        await expect(
          page.getByRole('textbox', { name: '任务草稿' }),
        ).toBeVisible()
      }
      await expect(page.locator('.resource-loading')).toHaveCount(0)
      for (const width of [1440, 1280, 768, 390]) {
        await page.setViewportSize({ width, height: width < 768 ? 844 : 1000 })
        await expect
          .poll(() =>
            page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          )
          .toBe(true)
        const content = page.locator('.console-content')
        expect(
          await content.evaluate(
            (element) => element.scrollWidth <= element.clientWidth + 1,
          ),
          `${module.path} at ${width}px`,
        ).toBe(true)
        if (width === 1440 || width === 390)
          await page.screenshot({
            path: info.outputPath(`${module.id}-${theme}-${width}.png`),
            animations: 'disabled',
          })
      }
    }
    expect(errors).toEqual([])
    expect(state.missing).toEqual([])
  })
}
