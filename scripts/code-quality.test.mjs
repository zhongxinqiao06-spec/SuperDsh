import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { test } from 'node:test'
import { ownedCodeFiles } from './code-quality.mjs'

test('quality checks include owned nested workspaces and exclude generated/runtime material', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'superdsh-quality-')))
  t.after(() => {
    assert.ok(realpathSync(root).startsWith(`${realpathSync(tmpdir())}${sep}`))
    assert.ok(root.includes('superdsh-quality-'))
    rmSync(root, { recursive: true, force: true })
  })
  const wanted = [
    'apps/admin/src/app/layout.tsx',
    'apps/admin/scripts/generate-protocol-types.mjs',
    'apps/desktop/vitest.config.ts',
    'apps/desktop/ui/src/features/chat.tsx',
    'apps/desktop/core/src/main/main.ts',
    'apps/desktop/core/src/client/settings.ts',
    'apps/desktop/core/src/lib/helper.ts',
    'apps/desktop/plugins/harness/src/index.ts',
    'apps/admin/server/runtime/host.mjs',
    'apps/admin/server/identity/service.ts',
    'apps/admin/deployment/compose.dependencies.yml',
    'scripts/check.mjs',
    'tsconfig.base.json',
    'compose.yml',
  ]
  const excluded = [
    'apps/admin/.next/server/main.js',
    'apps/admin/.next-console-validation/server/main.js',
    'apps/admin/out/assets/main.js',
    'apps/admin/src/generated/protocol/v1/event.ts',
    'apps/admin/next-env.d.ts',
    'apps/admin/server/contracts/openapi-v2.json',
    'apps/admin/server/contracts/legacy-routes.json',
    'apps/desktop/ui/src/compatibility/generated/api.js',
    'apps/desktop/ui/src/api-catalog.ts',
    'apps/desktop/ui/node_modules/pkg/index.ts',
    'apps/desktop/ui/client/market/client.js',
    'apps/desktop/ui/native-ui/index.js',
    'apps/desktop/core/lib/main.js',
    'apps/desktop/.superdsh/log.js',
    'apps/admin/server/runtime/node_modules/pkg/index.js',
    'deepseek-harness/src/engine.ts',
    'dsh-desktop-next/src/main.ts',
  ]
  for (const path of [...wanted, ...excluded]) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), '')
  }
  assert.deepEqual(
    ownedCodeFiles(root).map((file) =>
      relative(root, file).replaceAll('\\', '/'),
    ),
    [...wanted].sort(),
  )
})
