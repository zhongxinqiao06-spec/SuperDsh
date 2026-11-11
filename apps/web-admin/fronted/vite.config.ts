import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const directory = fileURLToPath(new URL('.', import.meta.url))
const repository = resolve(directory, '../../..')

/** 使用统一生成的构建信息，缺失时明确停止构建，不猜测发布版本。 */
export default defineConfig(() => {
  const buildInfo: unknown = JSON.parse(
    readFileSync(
      resolve(directory, '../backend/resources/build-info.json'),
      'utf8',
    ),
  )
  if (
    !buildInfo ||
    typeof buildInfo !== 'object' ||
    !('version' in buildInfo)
  ) {
    throw new Error('缺少有效构建信息，请先执行 web-admin 构建信息生成步骤')
  }
  const target = process.env.WEB_ADMIN_API_ORIGIN ?? 'http://127.0.0.1:8001'
  const validation =
    process.env.WEB_ADMIN_VALIDATION_DIR ??
    resolve(repository, '.superdsh-work/web-admin-validation/fronted-dev')
  return {
    root: directory,
    envDir: repository,
    plugins: [vue()],
    cacheDir: resolve(validation, 'vite-cache'),
    resolve: { alias: { '@': resolve(directory, 'src') } },
    define: { __WEB_ADMIN_BUILD__: JSON.stringify(buildInfo) },
    server: {
      host: 'localhost',
      port: Number(process.env.WEB_ADMIN_FRONTED_PORT ?? 5175),
      strictPort: true,
      proxy: {
        '/api': { target, ws: true },
        '/ws': { target, ws: true },
        '/health': { target },
      },
    },
    build: { outDir: resolve(directory, 'dist'), emptyOutDir: true },
  }
})
