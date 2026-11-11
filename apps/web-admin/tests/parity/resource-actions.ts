import { expect, type Page } from '@playwright/test'
import type { ResourceFixture } from './resource-fixture.ts'

/** 每个场景的断言在旧 React 与新 Vue 上复用；截图之外同时验证请求、草稿和行内容。 */
export const resourceScenarios = [
  'agent-draft',
  'skill-program-draft',
  'knowledge-conflict',
  'knowledge-upload',
  'file-pagination',
  'file-readonly',
] as const
export type ResourceScenario = (typeof resourceScenarios)[number]

/** 执行有填充数据的真实浏览器操作；capture 仅记录证据，不能代替断言。 */
export async function exerciseResourceScenario(
  page: Page,
  scenario: ResourceScenario,
  fixture: ResourceFixture,
  origin = '',
  capture: (stage: string) => Promise<void> = async () => {},
) {
  const visit = async (path: string) => {
    await page.goto(`${origin}/?resourceCase=${scenario}#${path}`)
    await page.waitForLoadState('networkidle')
  }
  if (scenario === 'skill-program-draft') {
    await visit('/skills')
    await page.getByRole('button', { name: '新增技能', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '新增技能', exact: true })
    await dialog
      .getByRole('button', { name: '使用 Word 流程起点', exact: true })
      .click()
    await expect(
      dialog.getByRole('textbox', { name: '输出类型', exact: true }),
    ).toHaveValue('docx')
    await expect(
      dialog.getByRole('spinbutton', { name: '最大修订次数', exact: true }),
    ).toHaveValue('2')
    await dialog
      .getByRole('textbox', { name: '匹配词（每行一项）', exact: true })
      .fill('合成自定义匹配\n用户可编辑')
    await dialog
      .getByRole('button', { name: '补齐多模态工具', exact: true })
      .click()
    await expect(
      dialog.getByRole('textbox', { name: '匹配词（每行一项）', exact: true }),
    ).toHaveValue('合成自定义匹配\n用户可编辑')
    await capture('editable-word-program')
    await dialog
      .getByRole('button', { name: '使用 PPT 流程起点', exact: true })
      .click()
    await expect(
      dialog.getByRole('textbox', { name: '输出类型', exact: true }),
    ).toHaveValue('pptx')
    await dialog
      .getByRole('button', { name: '撤销阶段草稿', exact: true })
      .click()
    await expect(
      dialog.getByRole('textbox', { name: '输出类型', exact: true }),
    ).toHaveCount(0)
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: '新增技能', exact: true }).click()
    await expect(
      dialog.getByRole('button', { name: '撤销阶段草稿', exact: true }),
    ).toHaveCount(0)
    expect(
      fixture.operations.filter((item) => item.path === '/admin/skills'),
    ).toEqual([])
    await capture('cancel-restored-empty-program')
    return
  }
  if (scenario === 'agent-draft') {
    await visit('/agents')
    const row = page.getByRole('row').filter({ hasText: '合成智能体' })
    await expect(row).toBeVisible()
    await row.getByRole('button', { name: '编辑', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '编辑智能体', exact: true })
    const sectioned =
      (await dialog
        .getByRole('tab', { name: '资源关联', exact: true })
        .count()) > 0
    if (sectioned) {
      await dialog.getByRole('tab', { name: '资源关联', exact: true }).click()
      await dialog.getByRole('tab', { name: /业务技能/ }).click()
    }
    const skill = dialog.getByRole('checkbox', { name: /合成阶段技能/ }),
      tool = dialog.getByRole('checkbox', { name: /合成依赖工具/ })
    await skill.check()
    if (sectioned) await dialog.getByRole('tab', { name: /可用工具/ }).click()
    await expect(tool).toBeChecked()
    if (sectioned)
      await dialog.getByRole('tab', { name: '基本信息', exact: true }).click()
    await dialog
      .getByRole('textbox', { name: '名称', exact: true })
      .fill('未保存的合成草稿')
    await capture('draft-with-required-tool')
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    if (sectioned)
      await page.getByRole('button', { name: '放弃修改', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    await row.getByRole('button', { name: '编辑', exact: true }).click()
    await expect(
      dialog.getByRole('textbox', { name: '名称', exact: true }),
    ).toHaveValue('合成智能体')
    if (sectioned) {
      await dialog.getByRole('tab', { name: '资源关联', exact: true }).click()
      await dialog.getByRole('tab', { name: /业务技能/ }).click()
    }
    await expect(skill).not.toBeChecked()
    if (sectioned) await dialog.getByRole('tab', { name: /可用工具/ }).click()
    await expect(tool).not.toBeChecked()
    expect(
      fixture.operations.filter(
        (item) => item.path === '/admin/agents/filled-agent',
      ),
    ).toEqual([])
    await capture('cancel-restored-original')
    return
  }
  if (scenario === 'knowledge-conflict' || scenario === 'knowledge-upload') {
    await visit('/knowledge')
    await page
      .getByRole('row')
      .filter({ hasText: '合成知识库' })
      .getByRole('button', { name: '管理文件', exact: true })
      .click()
    const manager = page.getByRole('dialog', {
      name: '管理文件 · 合成知识库',
      exact: true,
    })
    await expect(
      manager.getByRole('row').filter({ hasText: '合成资料.txt' }),
    ).toBeVisible()
    if (scenario === 'knowledge-conflict') {
      fixture.conflict = true
      await manager
        .getByRole('button', { name: '移出知识库', exact: true })
        .click()
      await expect(
        manager
          .getByText('版本冲突：请刷新知识库后重试', { exact: true })
          .first(),
      ).toBeVisible()
      await expect(
        manager.getByRole('row').filter({ hasText: '合成资料.txt' }),
      ).toBeVisible()
      expect(fixture.knowledge.assetIds).toEqual(['filled-asset'])
      expect(fixture.indexed).toBe(0)
      expect(
        fixture.operations.find((item) => item.method === 'PUT')?.body,
      ).toEqual(expect.objectContaining({ version: 7, assetIds: [] }))
      await capture('conflict-retains-link')
      return
    }
    await manager
      .getByRole('button', { name: '上传资料或模板', exact: true })
      .click()
    const uploader = page.getByRole('dialog', {
      name: '上传资料或模板',
      exact: true,
    })
    await uploader.locator('input[type=file]').setInputFiles({
      name: '上传资料.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('synthetic document only'),
    })
    await uploader.getByRole('button', { name: /^(上传|上传并解析)$/ }).click()
    await expect(uploader).not.toBeVisible()
    await expect(
      manager.getByRole('row').filter({ hasText: '上传资料.txt' }),
    ).toBeVisible()
    await expect.poll(() => fixture.indexed).toBe(1)
    expect(fixture.uploaded).toBe(1)
    expect(fixture.knowledge.assetIds).toEqual(['filled-asset', 'uploaded-1'])
    expect(
      fixture.operations.map((item) => `${item.method} ${item.path}`),
    ).toEqual([
      'POST /admin/agents/assets',
      'PUT /admin/knowledge-bases/filled-knowledge',
      'POST /admin/knowledge-bases/filled-knowledge/index',
    ])
    await capture('uploaded-linked-indexed')
    return
  }
  await visit('/account/files')
  await expect(page.locator('tbody tr')).toHaveCount(10)
  if (scenario === 'file-pagination') {
    await capture('first-ten')
    await page.getByRole('button', { name: '下一页', exact: true }).click()
    await expect(page.locator('tbody tr')).toHaveCount(3)
    await expect(
      page.getByRole('cell', { name: '合成文件13.txt', exact: true }),
    ).toBeVisible()
    await capture('second-page')
    await page
      .getByPlaceholder('搜索文件名', { exact: true })
      .fill('合成文件13')
    await expect(page.locator('tbody tr')).toHaveCount(1)
    await expect(
      page.getByRole('cell', { name: '合成文件13.txt', exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: '下一页', exact: true }),
    ).toBeDisabled()
    const last = fixture.reads.filter((item) => item.path === '/files').at(-1)!
    expect(last.query.page).toBe('1')
    expect(last.query.search ?? last.query.q).toBe('合成文件13')
    await capture('search-resets-pagination')
    return
  }
  await expect(
    page.getByRole('button', { name: '上传文件', exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: '上传新版', exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: '移到回收站', exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: '版本', exact: true }),
  ).toHaveCount(10)
  await capture('read-permission-only')
  fixture.filesForbidden = true
  await page.reload()
  await expect(
    page.getByText('文件读取权限已撤销', { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('cell', { name: '合成文件01.txt', exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: '上传文件', exact: true }),
  ).toHaveCount(0)
  expect(fixture.operations).toEqual([])
  await capture('revoked-read-permission')
}
