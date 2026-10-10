import { defineConfig } from 'vitest/config'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const aliases = (
  JSON.parse(
    readFileSync(new URL('./source-manifest.json', import.meta.url), 'utf8'),
  ) as { exports: Record<string, string> }
).exports
export default defineConfig({
  resolve: {
    alias: Object.entries(aliases).map(([find, replacement]) => ({
      find,
      replacement: resolve(import.meta.dirname, replacement),
    })),
  },
  test: { include: ['tests/**/*.spec.ts'], testTimeout: 20_000 },
})
