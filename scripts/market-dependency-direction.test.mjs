import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifyMarketDependencyDirection } from './market-dependency-direction.mjs'

test('allows product-name data in Market source', () => {
  assert.deepEqual(
    verifyMarketDependencyDirection([
      [
        'dsh-community-market/src/install.ts',
        "const blocked = new Set(['dsh-plugin-desktop'])\n",
      ],
    ]),
    { fileCount: 1 },
  )
})

test('rejects Market imports of Desktop implementation', () => {
  for (const target of [
    '@superdsh/desktop',
    '@superdsh/core/backend',
    '@superdsh/ui',
    '@superdsh/harness',
    '@superdsh/desktop/permissions',
    '../../apps/desktop/src/main.ts',
    'dsh-desktop-next',
  ]) {
    assert.throws(
      () =>
        verifyMarketDependencyDirection([
          [
            'dsh-community-market/src/index.ts',
            `import { runtime } from '${target}'`,
          ],
        ]),
      /must not import Desktop implementation/u,
    )
  }
  assert.throws(
    () =>
      verifyMarketDependencyDirection([
        [
          'dsh-community-market/src/index.ts',
          "import type { DesktopRuntime } from 'dsh-plugin-desktop/runtime'\n",
        ],
        [
          'dsh-community-market/src/beta.ts',
          "import type { DesktopRuntime } from 'dsh-plugin-desktop-beta/runtime'\n",
        ],
      ]),
    /must not import Desktop implementation/u,
  )
  assert.throws(
    () =>
      verifyMarketDependencyDirection([
        [
          'dsh-community-market/src/index.ts',
          "const desktop = await import('dsh-plugin-desktop')\n",
        ],
      ]),
    /must not import Desktop implementation/u,
  )
  assert.throws(
    () =>
      verifyMarketDependencyDirection([
        [
          'dsh-community-market/src/index.ts',
          "export { runtime } from '../../dsh-plugin-desktop/src/runtime.js'\n",
        ],
      ]),
    /must not import Desktop implementation/u,
  )
})

test('moved market code may share pure DTOs but must not reach desktop services', () => {
  const file = 'apps/desktop/ui/src/features/community-market/index.ts'
  assert.doesNotThrow(() =>
    verifyMarketDependencyDirection([
      [
        file,
        "import type { Response } from '@superdsh/core/contracts/community-market/api-types'",
      ],
    ]),
  )
  assert.throws(
    () =>
      verifyMarketDependencyDirection([
        [file, "import { shutdown } from '../../../../core/src/main/main.ts'"],
      ]),
    /must not import Desktop implementation/u,
  )
})
