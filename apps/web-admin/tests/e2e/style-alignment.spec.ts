import { expect, test } from '@playwright/test'
import { installFoundationFixture } from './foundation-fixture'
import type { DashboardOverview } from '../../fronted/src/types/service/system'

/** 合成展示数据只用于排版，不接触真实账号、数据库或执行引擎。 */
const dashboard: DashboardOverview = {
  summary: {
    totalUsers: 32,
    newUsers: 3,
    dau: 18,
    activeUsers: 24,
    wau: 27,
    mau: 30,
    totalMessages: 186,
    activeSessions: 42,
    totalDevices: 8,
  },
  series: [12, 16, 10, 18, 15, 22, 18].map((dau, index) => ({
    date: `2026-11-0${index + 1}`,
    dau,
    activeUsers: dau + 5,
    totalMessages: dau * 7,
    activeSessions: dau * 2,
  })),
  messageHistogram: [],
  sessionHistogram: [],
  userSegments: [],
  deviceBreakdown: [],
  agentBreakdown: [],
  sessionAgentBreakdown: [],
  settings: {
    intensity: { basis: 'messages', lightMax: 10, mediumMax: 50 },
    histogramBins: { messages: [0, 5, 20], sessions: [0, 1, 5] },
  },
}

for (const theme of ['light', 'dark']) {
  test(`原端视觉规范：${theme} 控件、管理弹窗、工作台与窄屏`, async ({
    page,
  }, info) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(
      (value) => localStorage.setItem('starbridge.theme', value),
      theme,
    )
    await installFoundationFixture(page)
    await page.route('**/api/admin/dashboard/overview?*', (route) =>
      route.fulfill({ json: dashboard }),
    )
    await page.route('**/api/announcement', (route) =>
      route.fulfill({ json: { announcement: null } }),
    )
    await page.goto('/#/login')
    await page.getByLabel('用户名或邮箱').fill('admin')
    await page.getByLabel('密码', { exact: true }).fill('Synthetic-password!')
    await page.screenshot({
      animations: 'disabled',
      path: info.outputPath(`login-${theme}.png`),
    })
    await page.getByRole('button', { name: '登录 ↵', exact: true }).click()
    await expect(page.locator('.dashboard-metrics article')).toHaveCount(4)
    await expect(page.locator('.console-sidebar')).toHaveCSS('width', '240px')
    await expect(page.locator('.console-header')).toHaveCSS('height', '56px')
    await expect(
      page.locator('.console-navigation .app-icon').first(),
    ).toBeVisible()
    await page.screenshot({
      animations: 'disabled',
      path: info.outputPath(`dashboard-${theme}.png`),
    })
    await page.goto('/#/access/users')
    await expect(page.getByRole('cell', { name: /合成成员/ })).toBeVisible()
    await page.screenshot({
      animations: 'disabled',
      path: info.outputPath(`users-${theme}.png`),
    })
    const create = page.getByRole('button', { name: '创建用户', exact: true })
    await expect(create).toHaveCSS('height', '36px')
    await expect(create).toHaveCSS('border-radius', '8px')
    // 深色主题下，框架默认白字不能覆盖浅色主按钮的前景语义。
    const contrast = await create.evaluate((button) => {
      const style = getComputedStyle(button)
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 1
      const context = canvas.getContext('2d')!
      const luminance = (color: string) => {
        context.clearRect(0, 0, 1, 1)
        context.fillStyle = color
        context.fillRect(0, 0, 1, 1)
        const rgb = [...context.getImageData(0, 0, 1, 1).data]
          .slice(0, 3)
          .map((value) => {
            const channel = value / 255
            return channel <= 0.04045
              ? channel / 12.92
              : ((channel + 0.055) / 1.055) ** 2.4
          })
        return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722
      }
      const a = luminance(style.color),
        b = luminance(style.backgroundColor)
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    })
    expect(contrast).toBeGreaterThan(4.5)
    await create.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('.el-dialog')).toHaveCSS('width', '672px')
    await expect(dialog.locator('.el-dialog')).toHaveCSS(
      'border-radius',
      '18px',
    )
    await dialog.getByLabel('用户名', { exact: true }).fill('仅验证展示')
    await page.screenshot({
      animations: 'disabled',
      path: info.outputPath(`user-dialog-${theme}.png`),
    })
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await page.goto('/#/workspace')
    await expect(page.getByRole('status')).toContainText('已就绪')
    await page.getByLabel('任务草稿').fill('整理本周数据，先给我一份分析方案。')
    await expect(page.locator('.composer')).toBeVisible()
    await page.screenshot({
      animations: 'disabled',
      path: info.outputPath(`workbench-${theme}.png`),
    })
    await page.setViewportSize({ width: 390, height: 844 })
    await page
      .getByRole('button', { name: '切换会话侧栏', exact: true })
      .click()
    await expect(page.getByLabel('任务草稿')).toHaveValue(
      '整理本周数据，先给我一份分析方案。',
    )
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
    await page.screenshot({
      animations: 'disabled',
      path: info.outputPath(`workbench-mobile-${theme}.png`),
    })
    await page.getByRole('button', { name: '打开导航', exact: true }).click()
    const navigation = page.getByRole('dialog')
    await expect(navigation).toHaveCSS('width', '256px')
    await navigation
      .getByRole('link', { name: '用户管理', exact: true })
      .click()
    await expect(navigation).toBeHidden()
    await expect(
      page.getByRole('heading', { name: '用户管理', exact: true }),
    ).toBeVisible()
    // 手机导航与退出确认同时存在时，取消必须把焦点归还给原操作。
    await page.getByRole('button', { name: '打开导航', exact: true }).click()
    const drawer = page.getByRole('dialog', { name: '平台导航', exact: true })
    await drawer.getByRole('button', { name: '退出登录', exact: true }).click()
    const confirmation = page.getByRole('dialog', {
      name: '退出登录',
      exact: true,
    })
    await confirmation
      .getByRole('button', { name: '取消', exact: true })
      .click()
    await expect(confirmation).toBeHidden()
    await expect(
      drawer.getByRole('button', { name: '退出登录', exact: true }),
    ).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
    expect(errors).toEqual([])
  })
}
