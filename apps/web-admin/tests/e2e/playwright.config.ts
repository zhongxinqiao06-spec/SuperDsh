import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { defineConfig } from '@playwright/test'

const directory = fileURLToPath(new URL('.', import.meta.url))
const repository = resolve(directory, '../../../..')
const output =
  process.env.WEB_ADMIN_VALIDATION_DIR ??
  resolve(repository, '.superdsh-work/web-admin-validation/fronted-e2e')
const baseURL = process.env.WEB_ADMIN_E2E_BASE_URL ?? 'http://localhost:5175'
// Windows 优先复用已安装的浏览器程序，仍使用独立的无头测试配置与临时会话。
// 显式通道优先；没有 Edge 的主机和 CI 继续使用 Playwright 安装的 Chromium。
const installedEdge =
  process.platform === 'win32' &&
  ['PROGRAMFILES(X86)', 'PROGRAMFILES', 'LOCALAPPDATA'].some((key) => {
    const directory = process.env[key]
    return (
      directory &&
      existsSync(resolve(directory, 'Microsoft/Edge/Application/msedge.exe'))
    )
  })
const channel =
  process.env.WEB_ADMIN_BROWSER_CHANNEL ??
  (installedEdge ? 'msedge' : undefined)

/** 浏览器证据写入统一验证目录；每个用例使用独立context隔离Cookie。 */
export default defineConfig({
  testDir: directory,
  testMatch: '**/*.spec.ts',
  outputDir: resolve(output, 'browser-artifacts'),
  timeout: 45_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [
    ['list'],
    ['json', { outputFile: resolve(output, 'browser-results.json') }],
  ],
  use: {
    baseURL,
    headless: true,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    channel,
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command:
      'node node_modules/vite/bin/vite.js --config apps/web-admin/fronted/vite.config.ts',
    cwd: repository,
    url: baseURL,
    reuseExistingServer: process.env.WEB_ADMIN_E2E_REUSE_SERVER === '1',
    timeout: 60_000,
    env: { WEB_ADMIN_VALIDATION_DIR: output },
  },
})
