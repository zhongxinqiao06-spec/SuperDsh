import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { defineConfig } from 'tsdown'
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  )
const entries = Object.fromEntries(
  walk('src')
    .filter(
      (file) =>
        file.endsWith('.ts') &&
        !file.replaceAll('\\', '/').includes('/preload/') &&
        !file.replaceAll('\\', '/').includes('/services/community-market/'),
    )
    .map((file) => [
      relative('src', file).replaceAll('\\', '/').replace(/\.ts$/, ''),
      file,
    ]),
)
entries['backend/import'] = 'src/backend/import/index.ts'
export default defineConfig([
  {
    entry: entries,
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: true,
    deps: { neverBundle: ['electron', /^@superdsh\/core(?:\/|$)/] },
  },
  ...['preload-app', 'preload-shell', 'preload-extension'].map((name) => ({
    entry: { ['preload/' + name]: 'src/preload/' + name + '.ts' },
    outDir: 'lib',
    format: 'cjs' as const,
    platform: 'node' as const,
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: { neverBundle: ['electron'] },
  })),
])
