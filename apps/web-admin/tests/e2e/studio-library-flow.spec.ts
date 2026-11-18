import { expect, test } from '@playwright/test'
import { installFoundationFixture } from './foundation-fixture'
import { captureDesign } from './design-capture'
import type { StudioAsset } from '../../fronted/src/types/studio/studio'
import type { LibraryUpdatePreview } from '../../fronted/src/types/studio/library'
import { studioProposalFixture } from '../fixtures/studio-proposal'

/** 合成角色与接口验证收藏入口和版本聚合，不写入真实作品或调用收费模型。 */
test('作品角色收藏后进入个人库，版本在详情展开，四档宽度主题保留操作', async ({
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
  const role: StudioAsset = {
    id: 'role-version',
    family: 'role-family',
    entityId: 'role-family',
    project: 'film',
    parent: null,
    kind: 'character',
    name: '小白',
    description: '保留耳朵与线条造型，声音保持原样。'.repeat(8),
    voice: 'original-voice',
    fileId: null,
    version: 4,
    variantId: 'shape',
    variantName: '日常造型',
    origin: null,
  }
  let personal: StudioAsset | undefined
  let collections = 0
  await page.route('**/api/studio/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/studio/library') {
      const projectScope = url.searchParams.get('scope') === 'project'
      const rows = projectScope
        ? [{ ...role, workId: 'film', workTitle: '太空旅行' }]
        : personal
          ? [{ ...personal, workId: null, workTitle: null }]
          : []
      return route.fulfill({ json: { total: rows.length, items: rows } })
    }
    if (url.pathname.endsWith('/detail')) {
      const current =
        personal && url.pathname.includes(personal.id) ? personal : role
      return route.fulfill({
        json: {
          asset: current,
          currentVersionId: current.id,
          archived: false,
          origin: current.origin,
          variants: [
            { id: 'shape', name: '日常造型', currentVersionId: current.id },
          ],
          versions: [{ ...current, id: 'old', version: 1 }, current],
        },
      })
    }
    if (url.pathname.endsWith('/usage'))
      return route.fulfill({ json: { total: 0, items: [] } })
    if (url.pathname.endsWith('/collections')) {
      const body = route.request().postDataJSON()
      expect(body.mode).toBe('new')
      expect(body.requestKey).toBeTruthy()
      collections++
      personal = {
        ...role,
        id: 'library-version',
        family: 'library-family',
        entityId: 'library-family',
        project: null,
        version: 1,
        origin: null,
      }
      role.origin = {
        family: personal.family,
        versionId: personal.id,
        currentVersionId: personal.id,
        hasUpdates: false,
        name: personal.name,
      }
      return route.fulfill({ json: { asset: personal, created: true } })
    }
    return route.fallback()
  })
  await page.goto('/#/entertainment/characters')
  await expect(
    page.getByRole('heading', { name: '角色库', exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: '从作品收藏', exact: true }).click()
  await expect(page.locator('.library-card')).toHaveCount(1)
  await page.getByRole('button', { name: '收藏到素材库', exact: true }).click()
  const collection = page.getByRole('dialog', {
    name: '保存到素材库',
    exact: true,
  })
  await expect(collection).toContainText('保存当前采用的参考图、设定和声音')
  await collection
    .getByRole('button', { name: '确认保存', exact: true })
    .click()
  await expect(collection).not.toBeVisible()
  expect(collections).toBe(1)
  await page.getByRole('tab', { name: '我的角色', exact: true }).click()
  await expect(page.locator('.library-card')).toHaveCount(1)
  await page
    .getByRole('button', { name: '查看小白的详情与版本', exact: true })
    .click()
  const detail = page.getByRole('dialog', { name: '小白', exact: true })
  await detail.getByRole('tab', { name: '造型与版本' }).click()
  await expect(detail.getByRole('button', { name: '查看此版本' })).toHaveCount(
    2,
  )
  for (const width of [390, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await expect(
        detail.getByRole('button', { name: '关闭', exact: true }),
      ).toBeVisible()
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true)
      await captureDesign(page, `library-detail-${width}-${colorScheme}.png`)
    }
  }
  await detail.getByRole('button', { name: '关闭', exact: true }).click()
  expect(personal?.voice).toBe('original-voice')
  expect(role.project).toBe('film')
})

/** 比较正文必须真实排版，不能只依赖可访问树存在或文本匹配来验收。 */
for (const theme of ['light', 'dark']) {
  test(`库内更新 ${theme}：四档宽度可读比较与冲突确认`, async ({ page }) => {
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
    ])
    identity.signedIn = true
    const { project } = studioProposalFixture()
    project.proposal = null
    const role = project.assets[0]!
    role.origin = {
      family: 'library-role',
      versionId: 'original-version',
      currentVersionId: 'updated-version',
      name: role.name,
      hasUpdates: true,
    }
    role.description = '本片保留蓝色背包，角色第一次来到海边。'.repeat(12)
    role.voice = '本片声音'
    const preview: LibraryUpdatePreview = {
      projectRevision: project.revision,
      assetId: role.id,
      sourceVersionId: 'updated-version',
      baseVersionId: 'original-version',
      fields: [
        {
          key: 'name',
          label: '名称',
          base: role.name,
          current: role.name,
          incoming: '小鹿的新名称',
          changed: true,
          localChanged: false,
          conflict: false,
        },
        {
          key: 'description',
          label: '设定',
          base: '原始设定',
          current: role.description,
          incoming: '素材库改成红色旅行箱，保留浅棕色毛发和圆润轮廓。'.repeat(
            12,
          ),
          changed: true,
          localChanged: true,
          conflict: true,
        },
        {
          key: 'voice',
          label: '声音',
          base: { voice: '原声音' },
          current: { voice: role.voice },
          incoming: { voice: '原声音' },
          changed: false,
          localChanged: true,
          conflict: false,
        },
      ],
      affected: { shots: [{ id: 'shot', number: 1 }], lines: [] },
    }
    let applied = 0
    const base = '/api/studio/projects/' + project.id
    await page.route('**/api/studio/**', async (route) => {
      const path = new URL(route.request().url()).pathname
      if (path === base) return route.fulfill({ json: project })
      if (path.endsWith('/preparation'))
        return route.fulfill({
          json: { revision: project.revision, stages: [] },
        })
      if (path.endsWith('/catalog'))
        return route.fulfill({
          json: { configurations: [], defaults: [], agents: [] },
        })
      if (path.endsWith('/library-updates/preview'))
        return route.fulfill({ json: preview })
      if (path.endsWith('/library-updates/apply')) {
        const body = route.request().postDataJSON()
        expect(body.fields).toEqual(['name', 'description'])
        expect(body.overwriteConflicts).toBe(true)
        expect(body.requestKey).toBeTruthy()
        applied++
        role.origin!.hasUpdates = false
        project.revision++
        return route.fulfill({
          json: {
            revision: project.revision,
            document: project.document,
            assets: project.assets,
            assetId: role.id,
          },
        })
      }
      return route.fallback()
    })
    await page.goto(`/#/entertainment/${project.id}?section=cast`)
    await page
      .getByRole('button', { name: '比较库内更新', exact: true })
      .click()
    const dialog = page.getByRole('dialog', {
      name: role.name + ' · 比较库内更新',
      exact: true,
    })
    const submit = dialog.getByRole('button', {
      name: '采用所选更新',
      exact: true,
    })
    await expect(
      dialog.getByRole('checkbox', { name: '更新名称', exact: true }),
    ).toBeChecked()
    await expect(
      dialog.getByRole('checkbox', { name: '更新设定', exact: true }),
    ).not.toBeChecked()
    await expect(
      dialog.getByRole('checkbox', { name: '更新声音', exact: true }),
    ).toHaveCount(0)
    for (const width of [390, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      await expect(submit).toBeInViewport()
      const text = dialog.locator(
        '.library-detail-grid strong, .library-detail-grid .expandable-text p',
      )
      expect(await text.count()).toBe(8)
      for (const item of await text.all()) {
        await expect(item).toBeVisible()
        expect((await item.boundingBox())?.height ?? 0).toBeGreaterThan(0)
        await expect(item).not.toHaveCSS('font-size', '0px')
      }
      expect(
        await dialog.evaluate(
          (element) => element.scrollWidth <= element.clientWidth + 1,
        ),
      ).toBe(true)
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      ).toBe(true)
      await captureDesign(page, `library-update-${theme}-${width}.png`)
    }
    await dialog.getByText('更新设定', { exact: true }).click()
    await expect(
      dialog.getByRole('checkbox', { name: '更新设定', exact: true }),
    ).toBeChecked()
    await expect(submit).toBeDisabled()
    await dialog
      .getByText('我确认用所选库内内容替换本片对应修改', { exact: true })
      .click()
    await expect(submit).toBeEnabled()
    await submit.click()
    await expect(dialog).not.toBeVisible()
    expect(applied).toBe(1)
    expect(role.voice).toBe('本片声音')
  })
}
