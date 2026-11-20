import { expect, test } from '@playwright/test'
import { installFoundationFixture } from './foundation-fixture'

test('选中的故事镜头可放大，八步手记可逐步阅读，暂停动效可跨屏保留', async ({
  page,
}) => {
  await installFoundationFixture(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1280, height: 600 })
  await page.goto('/#/')
  const navigation = page.getByRole('navigation', { name: '章节导航' })
  await navigation.getByRole('button', { name: '创作类型' }).click()
  const gallery = page.locator('#studio-creations')
  await gallery.getByRole('button', { name: '旅人近景' }).click()
  const enlarge = gallery.getByRole('button', { name: '放大故事短片' })
  await enlarge.click()
  await expect(page.getByRole('dialog').locator('img')).toHaveAttribute(
    'src',
    /premiere-color\.webp$/,
  )
  await page.keyboard.press('Escape')
  await expect(enlarge).toBeFocused()
  await navigation.getByRole('button', { name: '制作流程' }).click()
  const process = page.locator('#film-case')
  await process.getByRole('button', { name: '剧本与场次' }).click()
  await expect(process.locator('.process-detail')).toContainText('攥紧车票')
  await process.getByRole('button', { name: '查看下一步' }).click()
  await expect(
    process.getByRole('button', { name: '角色与场景' }),
  ).toHaveAttribute('aria-pressed', 'true')
  await process.getByRole('button', { name: '空车', exact: true }).click()
  await expect(process.locator('.preview-meta')).toContainText('远去的空车')
  const finalFrame = await process.locator('.process-final').boundingBox()
  const rail = await process.locator('.process-rail').boundingBox()
  expect(finalFrame!.y + finalFrame!.height).toBeLessThan(rail!.y)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await process.getByRole('button', { name: '暂停背景动效' }).click()
  await navigation.getByRole('button', { name: '开始创作' }).click()
  const last = page.locator('#studio-start')
  await expect(last.getByRole('button', { name: '播放背景动效' })).toBeVisible()
  await expect(last.locator('.closing-mist')).toHaveCSS(
    'animation-play-state',
    'paused',
  )
  await last.getByRole('button', { name: '播放背景动效' }).click()
  await expect(last.locator('.closing-mist')).toHaveCSS(
    'animation-play-state',
    'running',
  )
})

test('首屏胶片与四张后景画片自动运动，可暂停和续播，减少动态时定格', async ({
  page,
}) => {
  await installFoundationFixture(page)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/#/')
  const intro = page.locator('#studio-intro')
  const film = intro.locator('svg.premiere-film-loop')
  const frame = film.locator('g:has(> animateMotion)').first()
  const position = () => frame.evaluate((el: SVGGElement) => el.getCTM()!.e)
  const paused = () =>
    film.evaluate((el: SVGSVGElement) => el.animationsPaused())
  const prints = intro.locator('.premiere-print, .premiere-backprint')
  await expect(prints).toHaveCount(4)
  const poses = () =>
    prints.evaluateAll((nodes) =>
      nodes.map((node) => getComputedStyle(node).transform),
    )
  const movingSince = (previous: string[]) =>
    expect
      .poll(async () =>
        (await poses()).every((pose, i) => pose !== previous[i]),
      )
      .toBe(true)
  const stage = intro.locator('.premiere-stage')
  const stageBounds = await stage.boundingBox()
  await movingSince(await poses())
  const first = await position()
  await expect
    .poll(async () => Math.abs((await position()) - first))
    .toBeGreaterThan(2)
  await intro.getByRole('button', { name: '暂停背景动效' }).click()
  await expect.poll(paused).toBe(true)
  for (const print of await prints.all())
    await expect(print).toHaveCSS('animation-play-state', 'paused')
  const pausedPoses = await poses()
  const stopped = await position()
  await intro.getByRole('button', { name: '播放背景动效' }).click()
  await movingSince(pausedPoses)
  expect(await stage.boundingBox()).toEqual(stageBounds)
  await expect
    .poll(async () => Math.abs((await position()) - stopped))
    .toBeGreaterThan(2)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(paused).toBe(true)
  for (const print of await prints.all())
    await expect(print).toHaveCSS('animation-name', 'none')
  await expect(intro.getByRole('button', { name: '暂停背景动效' })).toHaveCount(
    0,
  )
})

test('官网演示可以暂停、续播、手动对照和重播，阶段跳转仍走现有章节', async ({
  page,
}) => {
  await installFoundationFixture(page)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/#/')
  const intro = page.locator('#studio-intro')
  const slider = intro.getByRole('slider')
  await intro.getByRole('button', { name: '看创作过程' }).click()
  await expect(intro.getByText('外景 · 老城街口 · 黄昏')).toBeVisible()
  await intro.getByRole('button', { name: '暂停演示' }).click()
  await intro.getByRole('button', { name: '继续演示' }).click()
  await expect(intro.getByRole('button', { name: '再看一次' })).toBeVisible({
    timeout: 8000,
  })
  await expect(slider).toHaveValue('0')
  await intro.getByRole('button', { name: '再看一次' }).click()
  await intro.getByRole('button', { name: '分镜', exact: true }).click()
  await expect(slider).toHaveValue('100')
  await slider.focus()
  await slider.press('ArrowLeft')
  await expect(slider).toHaveValue('99')
  const box = await slider.boundingBox()
  if (!box) throw new Error('无法定位样片滑杆')
  await page.mouse.move(box.x + box.width - 9, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.32, box.y + box.height / 2, {
    steps: 8,
  })
  await page.mouse.up()
  expect(Number(await slider.inputValue())).toBeLessThan(40)
  await intro.getByRole('button', { name: '看创作过程' }).click()
  await intro.getByRole('button', { name: '探索八步创作流程' }).click()
  const chapters = page.getByRole('navigation', { name: '章节导航' })
  await expect(
    chapters.getByRole('button', { name: '制作流程' }),
  ).toHaveAttribute('aria-current', 'step')
  await chapters.getByRole('button', { name: '灵感开场' }).click()
  await expect(intro.getByRole('button', { name: '继续演示' })).toBeVisible()
})

test('减少动态时用户逐步切换剧本、分镜、成片', async ({ page }) => {
  await installFoundationFixture(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/#/')
  const intro = page.locator('#studio-intro')
  await expect(intro.getByRole('slider')).toHaveValue('38')
  await intro.getByRole('button', { name: '看创作过程' }).click()
  await expect(
    intro.getByRole('button', { name: '剧本', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
  await intro.getByRole('button', { name: '看下一步' }).click()
  await expect(intro.getByRole('slider')).toHaveValue('100')
  await intro.getByRole('button', { name: '看下一步' }).click()
  await expect(
    intro.getByRole('button', { name: '成片', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
})
