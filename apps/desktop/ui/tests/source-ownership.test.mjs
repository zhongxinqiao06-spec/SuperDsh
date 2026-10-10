import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import {
  assertBrowserInput,
  readSourceManifest,
} from '../scripts/source-ownership.mjs'
const root = fileURLToPath(new URL('..', import.meta.url))
const json = (file) => JSON.parse(readFileSync(resolve(root, file), 'utf8'))

test('all imported browser faces have editable source and keep their upstream module IDs', () => {
  const source = readSourceManifest(root)
  assert.equal(Object.keys(source.modules).length, 70)
  for (const [id, row] of Object.entries(source.modules)) {
    assert.ok(
      id.startsWith('@deepseek-ai/dsh-') ||
        id === '@superdsh/desktop' ||
        id === 'dsh-community-market',
    )
    assert.ok(row.entry.startsWith('src/'))
    assert.ok(existsSync(resolve(root, row.entry)), id)
  }
  for (const name of [
    'ui-chat',
    'ui-conversation',
    'ui-sidebar',
    'ui-tool',
    'ui-workflow-run',
  ]) {
    assert.ok(source.modules[`@deepseek-ai/dsh-client-${name}`], name)
  }
  assert.deepEqual(
    json('src/owned-modules.json'),
    Object.keys(source.modules).sort(),
  )
})

test('browser inputs cannot silently fall back to vendor UI or the upstream checkout', () => {
  for (const bad of [
    'D:/repo/deepseek-harness/packages/client/ui-chat/src/client/index.ts',
    'D:\\repo\\node_modules\\@deepseek-ai\\dsh-client-ui-primitives\\lib\\index.js',
  ]) {
    assert.throws(() => assertBrowserInput(bad, root), /owned source/)
  }
  assertBrowserInput(resolve(root, 'src/features/chat/index.ts'), root)
})

test('built page and every dynamic module use owned source with a single original registration', () => {
  const artifacts = json('client-manifest.json'),
    inputs = json('build-sources.json')
  assert.equal(artifacts.sourceDigest, inputs.sourceDigest)
  assert.deepEqual(
    Object.keys(artifacts.modules).sort(),
    Object.keys(readSourceManifest(root).modules).sort(),
  )
  for (const [id, row] of Object.entries(artifacts.modules)) {
    const registrations = []
    runInNewContext(readFileSync(resolve(root, row.path), 'utf8'), {
      window: {
        __ModuleLoader__: { load: (value) => registrations.push(value) },
      },
    })
    assert.deepEqual(
      registrations.map((value) => value.id),
      [id],
      id,
    )
    assert.ok(
      inputs.modules[id].some((file) => file.startsWith('src/')),
      id,
    )
    for (const input of inputs.modules[id]) assertBrowserInput(input, root)
  }
  assert.ok(
    inputs.modules['@superdsh/ui/static'].includes(
      'src/components/primitives/index.ts',
    ),
  )
  assert.ok(
    inputs.modules['@superdsh/ui/static'].includes('src/app/ProductApp.tsx'),
  )
  assert.match(
    readFileSync(resolve(root, 'dist/index.html'), 'utf8'),
    /<title>SuperDsh<\/title>/,
  )
})

test('the static platform retains singleton identities and usable UI exports', () => {
  const platform = json('dist/platform-contract.json')
  assert.equal(new Set(platform.modules).size, platform.modules.length)
  for (const id of [
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-ui-primitives',
  ])
    assert.ok(platform.modules.includes(id), id)
  for (const name of ['Button', 'Input', 'Modal'])
    assert.ok(
      platform.exports['@deepseek-ai/dsh-client-ui-primitives'].includes(name),
      name,
    )
})
