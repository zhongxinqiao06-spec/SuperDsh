import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { installParityFixture } from './ui-fixture.ts'

const output = resolve(
  process.env.WEB_ADMIN_UI_OUTPUT ??
    '.superdsh-work/web-admin-validation/phase-three-ui',
)
await mkdir(resolve(output, 'interactions'), { recursive: true })
const selectedTargets = process.env.PARITY_UI_TARGETS?.split(',')
const selectedCases = process.env.PARITY_UI_CASES?.split(',')
const selectedEntries = process.env.PARITY_UI_ENTRIES?.split(',')
const reportFile =
  process.env.PARITY_UI_INTERACTION_REPORT ?? 'ui-interactions.json'
const cases = [
  {
    id: 'appearance-dark',
    path: '/account/appearance',
    action: ['深色', '深色'],
    role: 'radio',
  },
  { id: 'workbench-new', path: '/workspace', action: ['新会话', '新会话'] },
  { id: 'overview-usage', path: '/overview', action: ['使用', '使用'] },
  {
    id: 'devices-refresh',
    path: '/operations/devices',
    action: ['刷新', '刷新'],
  },
  { id: 'audit-search', path: '/system/audit', action: ['搜索', '搜索'] },
  {
    id: 'service-access',
    path: '/system/service',
    action: ['编辑配置', '编辑配置'],
  },
  {
    id: 'profile-name',
    path: '/account/profile',
    action: ['修改昵称', '修改昵称'],
  },
  {
    id: 'profile-email',
    path: '/account/profile',
    action: ['绑定邮箱', '绑定邮箱'],
    validation: true,
  },
  {
    id: 'personal-provider',
    path: '/account/models',
    action: ['添加供应商', '添加供应商'],
    validation: true,
  },
  {
    id: 'user-create',
    path: '/access/users',
    action: ['创建用户', '创建用户'],
    validation: true,
  },
  {
    id: 'role-readonly',
    path: '/access/roles',
    action: ['查看权限', '查看权限'],
  },
  {
    id: 'role-create',
    path: '/access/roles',
    action: ['创建角色', '创建角色'],
    validation: true,
  },
  {
    id: 'menu-group',
    path: '/access/menus',
    action: ['新增分组', '新增分组'],
    validation: true,
  },
  {
    id: 'agent-create',
    path: '/agents',
    action: ['新增智能体', '新增智能体'],
    validation: true,
  },
  {
    id: 'knowledge-create',
    path: '/knowledge',
    action: ['新增知识库', '新增知识库'],
    validation: true,
  },
  {
    id: 'skill-create',
    path: '/skills',
    action: ['新增技能', '新增技能'],
    validation: true,
  },
  {
    id: 'tool-create',
    path: '/tools',
    action: ['新增工具', '新增工具'],
    validation: true,
  },
  {
    id: 'model-create',
    path: '/models',
    action: ['新增配置', '新增配置'],
    validation: true,
  },
  {
    id: 'multimodal-create',
    path: '/models/multimodal',
    action: ['新增配置', '新增配置'],
    validation: true,
  },
  {
    id: 'model-connections',
    path: '/models',
    action: ['供应商连接', '供应商连接'],
  },
  {
    id: 'storage-policy',
    path: '/system/storage',
    action: ['策略与默认存储', '策略与默认存储'],
  },
  { id: 'file-recycle', path: '/account/files', action: ['回收站', '回收站'] },
  {
    id: 'security-password',
    path: '/account/security',
    action: ['重置密码', '重置密码'],
    validation: true,
  },
  {
    id: 'mobile-connect',
    path: '/account/mobile',
    action: ['添加另一部手机 / 扫码登录', '添加另一部手机 / 扫码登录'],
  },
] as const
const entries = [
  { id: 'website', legacy: '/', current: '/#/' },
  { id: 'privacy', legacy: '/privacy', current: '/#/privacy' },
  { id: 'login', legacy: '/#/login', current: '/#/login' },
  { id: 'register', legacy: '/#/register', current: '/#/register' },
  { id: 'mobile-oauth', legacy: '/#/mobile-oauth', current: '/#/mobile-oauth' },
  {
    id: 'desktop-oauth',
    legacy: '/#/desktop-oauth',
    current: '/#/desktop-oauth',
  },
  { id: 'plugin-oauth', legacy: '/#/plugin-oauth', current: '/#/plugin-oauth' },
  { id: 'file-preview-missing', legacy: '/preview', current: '/#/preview' },
  {
    id: 'share-missing',
    legacy: '/share/synthetic-missing',
    current: '/#/share/synthetic-missing',
  },
] as const
/** 双应用真实点击及非菜单入口证据；逐项保留失败，不把成功打开页面当功能等价。 */
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const report: unknown[] = []
try {
  for (const target of ['legacy', 'current'] as const) {
    if (selectedTargets && !selectedTargets.includes(target)) continue
    const origin =
      target === 'legacy'
        ? (process.env.WEB_ADMIN_LEGACY_UI_URL ?? 'http://localhost:5188')
        : (process.env.WEB_ADMIN_CURRENT_UI_URL ?? 'http://localhost:5187')
    const context = await browser.newContext({
      locale: 'zh-CN',
      viewport: { width: 1440, height: 1000 },
      colorScheme: 'light',
      timezoneId: 'Asia/Shanghai',
    })
    await context.addInitScript(() => {
      localStorage.setItem('theme', 'light')
      localStorage.setItem('starbridge.theme', 'light')
      localStorage.setItem('agents-anywhere.locale', 'zh-CN')
      localStorage.setItem('agents-anywhere.locale.source', 'manual')
    })
    const page = await context.newPage()
    const fixture = await installParityFixture(page)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    async function capture(id: string) {
      await page.screenshot({
        path: resolve(output, 'interactions', `${target}-${id}.png`),
        fullPage: true,
        animations: 'disabled',
      })
      return {
        text: await page.locator('body').innerText(),
        actions: await page.getByRole('button').allTextContents(),
        url: page.url(),
      }
    }
    for (const scenario of cases) {
      if (selectedCases && !selectedCases.includes(scenario.id)) continue
      const errorStart = errors.length,
        requestStart = fixture.requests.length
      let failure = ''
      let opened: unknown, validation: unknown
      try {
        await page.goto(`${origin}/?scenario=${scenario.id}#${scenario.path}`)
        await page.waitForLoadState('networkidle')
        await page
          .getByRole('role' in scenario ? scenario.role : 'button', {
            name: scenario.action[target === 'legacy' ? 0 : 1],
            exact: !('role' in scenario),
          })
          .first()
          .click({ timeout: 6000 })
        await page.waitForTimeout(300)
        opened = await capture(scenario.id)
        if ('validation' in scenario) {
          const submit = page
            .getByRole('dialog')
            .getByRole('button', { name: /^(保存|创建|确认)$/ })
            .last()
          if ((await submit.count()) && (await submit.isEnabled())) {
            await submit.click()
            await page.waitForTimeout(200)
            validation = await capture(`${scenario.id}-validation`)
          } else validation = { submitDisabled: true }
        }
        await page.keyboard.press('Escape')
      } catch (error) {
        failure = String(error)
      }
      report.push({
        target,
        scenario: scenario.id,
        opened,
        validation,
        failure,
        errors: errors.slice(errorStart),
        requests: fixture.requests.slice(requestStart),
      })
      await writeFile(
        resolve(output, reportFile),
        JSON.stringify(report, null, 2),
      )
      process.stdout.write(
        `${target} ${scenario.id}: ${failure ? 'failed' : 'captured'}\n`,
      )
    }
    fixture.signedIn = false
    for (const entry of entries) {
      if (selectedEntries && !selectedEntries.includes(entry.id)) continue
      let evidence: unknown,
        failure = ''
      try {
        const address = new URL(`${origin}${entry[target]}`)
        address.searchParams.set('capture', entry.id)
        await page.goto(address.toString())
        await page.waitForLoadState('networkidle')
        evidence = await capture(entry.id)
      } catch (error) {
        failure = String(error)
      }
      report.push({ target, entry: entry.id, evidence, failure })
      await writeFile(
        resolve(output, reportFile),
        JSON.stringify(report, null, 2),
      )
    }
    await context.close()
  }
} finally {
  await browser.close()
}
