import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

const directory = fileURLToPath(new URL('.', import.meta.url))
const application = resolve(directory, '../..')
const repository = resolve(application, '../..')
const output =
  process.env.WEB_ADMIN_VALIDATION_DIR ??
  resolve(repository, '.superdsh-work/web-admin-validation/fronted-tests')

/** 测试源与过程文件集中隔离，配置不影响生产类型检查和打包。 */
export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { '@': resolve(application, 'fronted/src') } },
  cacheDir: resolve(output, 'vitest-cache'),
  test: {
    // 单一线程池避免 Windows 子进程加载大依赖时挂起，各测试仍隔离模块与DOM。
    pool: 'threads',
    maxWorkers: 1,
    fileParallelism: false,
    root: directory,
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://localhost:5175/' } },
    include: ['**/*.test.ts'],
    setupFiles: [resolve(directory, 'setup.ts')],
    reporters: ['default', 'json'],
    outputFile: { json: resolve(output, 'fronted-tests.json') },
    coverage: { reportsDirectory: resolve(output, 'coverage') },
    clearMocks: true,
    restoreMocks: true,
  },
})
