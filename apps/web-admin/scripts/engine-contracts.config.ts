import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'tsdown'
import { repositoryRoot } from './paths.ts'

const source = resolve(repositoryRoot, 'apps/desktop/core/src/contracts')

/** 干净构建先准备固定 Harness 依赖的公共契约，不引入桌面或旧平台业务。 */
export default defineConfig({
  entry: Object.fromEntries(
    readdirSync(source)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => [name.slice(0, -3), resolve(source, name)]),
  ),
  outDir: resolve(repositoryRoot, 'apps/desktop/core/lib/contracts'),
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  outExtensions: () => ({ js: '.js' }),
  dts: false,
  clean: false,
})
