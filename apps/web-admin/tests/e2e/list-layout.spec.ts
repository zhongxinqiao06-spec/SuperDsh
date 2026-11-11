import { expect, test, type Page } from '@playwright/test'
import { installParityFixture } from '../parity/ui-fixture'
import { installResourceFixture } from '../parity/resource-fixture'
import type { ModelCatalog } from '../../fronted/src/types/models/models'

/** 合成模型目录只在浏览器上下文中生效，用于验证行权限、默认操作和分页。 */
async function installCatalog(page: Page, count: number) {
  await installParityFixture(page)
  const catalog: ModelCatalog = {
    configurations: Array.from({ length: count }, (_, index) => ({
      id: 'model-' + index,
      name: '模型 ' + (index + 1),
      modelId: 'synthetic-' + index,
      connectionId: 'local',
      capability: 'chat',
      kind: 'chat',
      revision: 1,
      enabled: index !== 3,
      parameters: {},
      roleIds: [],
    })),
    connections: [
      {
        id: 'local',
        name: '测试连接',
        adapter: 'openai-completions',
        enabled: true,
        region: '',
        baseUrl: 'https://synthetic.invalid',
        revision: 1,
        scope: 'platform',
        credentialConfigured: true,
      },
    ],
    capabilities: [
      {
        id: 'chat',
        name: '聊天',
        available: true,
        configurationSchema: { properties: {} },
      },
    ],
    defaults: [{ capability: 'chat', configurationId: 'model-0', revision: 1 }],
  }
  await page.route('**/api/admin/models/configurations', (route) =>
    route.fulfill({ json: catalog }),
  )
  await page.route('**/api/admin/models/defaults/chat', async (route) => {
    const { configurationId } = route.request().postDataJSON()
    catalog.defaults = [{ capability: 'chat', configurationId, revision: 2 }]
    await route.fulfill({ json: {} })
  })
}

test('四条模型的工具栏、直接操作和内容区底部分页', async ({ page }, info) => {
  await installCatalog(page, 4)
  await page.goto('/#/models')
  const main = page.locator('.console-content')
  await expect(main.locator('.page-heading')).toHaveText('聊天模型')
  await expect(main.getByText(/已配置.*个供应商连接/u)).toHaveCount(0)
  const bar = main.getByRole('search')
  await expect(bar.locator('input,button')).toHaveCount(3)
  await expect(bar.locator('input,button').first()).toHaveAccessibleName(
    '搜索模型配置',
  )
  await expect(bar.getByRole('button')).toHaveText(['新增配置', '供应商连接'])
  const row = main
    .getByRole('row')
    .filter({ has: page.getByText('模型 1', { exact: true }) })
  await expect(row.getByRole('button')).toHaveText([
    '编辑',
    '只读检测',
    '清除默认',
  ])
  await expect(
    main
      .getByRole('row')
      .filter({ hasText: '模型 4' })
      .getByRole('button', { name: '设为默认' }),
  ).toBeDisabled()
  const pager = main.getByRole('navigation', { name: '列表分页' })
  for (const width of [1440, 1280, 768, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
    await expect
      .poll(async () => {
        const rect = await pager.boundingBox()
        return rect
          ? Math.abs(page.viewportSize()!.height - rect.y - rect.height)
          : Infinity
      })
      .toBeLessThanOrEqual(32)
    expect(
      await main.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true)
    if (width === 390) {
      const target = row.getByRole('button', { name: '只读检测' })
      await expect(target).toBeInViewport()
      const table = row.locator('xpath=ancestor::table')
      expect(
        await table.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      ).toBe(true)
      await page.screenshot({
        path: info.outputPath('four-models-mobile.png'),
        animations: 'disabled',
      })
    }
    if (width === 1440)
      await page.screenshot({
        path: info.outputPath('four-models.png'),
        animations: 'disabled',
      })
  }
  await page.setViewportSize({ width: 1280, height: 800 })
  await bar.getByRole('button', { name: '供应商连接' }).click()
  const dialog = page.getByRole('dialog', { name: '供应商连接' })
  await expect(dialog.getByRole('heading', { name: '测试连接' })).toBeVisible()
  await dialog.getByRole('button', { name: '关闭此对话框' }).click()
  await row.getByRole('button', { name: '清除默认' }).click()
  await expect(row.getByRole('button', { name: '设为默认' })).toBeEnabled()
  await row.getByRole('button', { name: '设为默认' }).click()
  await expect(row.getByRole('button', { name: '清除默认' })).toBeEnabled()
  let release!: () => void
  const paused = new Promise<void>((resolve) => {
    release = resolve
  })
  let calls = 0
  await page.route(
    '**/api/admin/models/configurations/model-0/verify',
    async (route) => {
      calls++
      await paused
      await route.fulfill({
        json: {
          ok: true,
          status: 'verified',
          message: '隔离检测完成',
          serverTime: '2026-11-11T00:00:00Z',
        },
      })
    },
  )
  await row.getByRole('button', { name: '只读检测' }).click()
  try {
    await expect(row.getByRole('button', { name: '只读检测' })).toBeDisabled()
    await expect(row.getByRole('button', { name: '清除默认' })).toBeDisabled()
    await expect.poll(() => calls).toBe(1)
  } finally {
    release()
  }
  await expect(main.getByText('隔离检测完成')).toBeVisible()
  await bar.getByRole('textbox').fill('无匹配项')
  await expect(pager).toBeHidden()
  await expect(main.getByText(/搜索条件/u)).toBeVisible()
})

test('多页数据在列表内滚动，末行在页脚上方，切页回到列表顶部', async ({
  page,
}) => {
  await installCatalog(page, 24)
  await page.setViewportSize({ width: 1280, height: 620 })
  await page.goto('/#/models')
  const list = page.getByRole('region', { name: '列表内容' })
  const pager = page.getByRole('navigation', { name: '列表分页' })
  await expect(pager).toContainText('共 24 条')
  const before = await pager.boundingBox()
  await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  const last = await list.getByRole('row').last().boundingBox()
  expect(last!.y + last!.height).toBeLessThanOrEqual(before!.y + 1)
  expect((await pager.boundingBox())!.y).toBe(before!.y)
  await pager.getByRole('button', { name: '下一页' }).click()
  await expect(pager).toContainText('11–20')
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBe(0)
})

test('文件行直接提供管理动作，取消回收不写入，确认后可恢复', async ({
  page,
}) => {
  const fixture = await installResourceFixture(page)
  await page.goto('/#/account/files')
  const row = page.getByRole('row').filter({ hasText: '合成文件01.txt' })
  const trash = row.getByRole('button', { name: '移到回收站' })
  await trash.click()
  const confirmation = page
    .locator('.el-popconfirm')
    .filter({ hasText: '合成文件01.txt' })
  await confirmation.getByRole('button', { name: '取消' }).click()
  await expect(confirmation).toBeHidden()
  expect(fixture.operations).toHaveLength(0)
  await trash.click()
  await confirmation.getByRole('button', { name: '移到回收站' }).click()
  await expect(row).toHaveCount(0)
  await page.getByRole('button', { name: '回收站', exact: true }).click()
  await row.getByRole('button', { name: '恢复' }).click()
  await expect(row).toHaveCount(0)
  await page.getByRole('button', { name: '返回文件' }).click()
  await expect(row).toBeVisible()
  expect(fixture.operations.map(({ method, path }) => [method, path])).toEqual([
    ['POST', '/files/filled-file-1/trash'],
    ['POST', '/files/filled-file-1/restore'],
  ])
})
