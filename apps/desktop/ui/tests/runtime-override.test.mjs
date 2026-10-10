import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Registry, {
  superdshClientArtifactManifestVersion,
} from '@deepseek-ai/dsh-client-modules'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'superdsh-client-'))
  const id = '@fixture/plugin'
  const dir = join(root, 'node_modules/@fixture/plugin')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: id,
      type: 'module',
      exports: {
        '.': './index.js',
        './client': './client.js',
        './package.json': './package.json',
      },
      dsh: { client: { platform: 'web', inject: [] } },
    }),
  )
  writeFileSync(join(dir, 'index.js'), 'export const name = "fixture";')
  writeFileSync(
    join(dir, 'client.js'),
    'window.__ModuleLoader__.load({id:"@fixture/plugin",factory:()=>({source:"vendor"})});',
  )
  writeFileSync(
    join(root, 'owned.js'),
    'window.__ModuleLoader__.load({id:"@fixture/plugin",factory:()=>({source:"owned"})});',
  )
  const file = join(root, 'client-manifest.json')
  const row = { path: 'owned.js', inject: [], external: [], immediately: true }
  const write = (modules) =>
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        harnessVersion: '0.1.7-alpha.2',
        modules,
      }),
    )
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  ctx.provide('loader', {
    *entries() {
      yield {
        options: { name: id },
        fiber: {},
        disabled: false,
        parent: { tree: { ctx: { baseUrl: ctx.baseUrl } } },
      }
    },
  })
  return {
    root,
    id,
    dir,
    file,
    row,
    ctx,
    write,
    dispose: async () => {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

test('product artifacts override the first graph snapshot and preserve module identity', async () => {
  assert.equal(superdshClientArtifactManifestVersion, 1)
  const f = fixture()
  try {
    f.write({ [f.id]: f.row })
    const registry = new Registry(f.ctx, { clientArtifactManifest: f.file })
    assert.equal(registry.clientPath(f.id), join(f.root, 'owned.js'))
    const graph = registry.graph()
    assert.ok(JSON.stringify(graph).includes(f.id))
    assert.equal(graph.entries.find((row) => row.id === f.id).immediately, true)
    assert.equal(
      readFileSync(registry.clientPath(f.id), 'utf8').includes(
        'source:"owned"',
      ),
      true,
    )
    writeFileSync(
      join(f.root, 'owned.js'),
      'window.__ModuleLoader__.load({id:"@fixture/plugin",factory:()=>({source:"owned revision two"})});',
    )
    assert.ok(registry.rebuilt(f.id))
    assert.notEqual(
      registry.graph().rev,
      graph.rev,
      'Owned source rebuilds retain the original revision mechanism',
    )
  } finally {
    await f.dispose()
  }
})

test('unmatched third-party plugins keep their original client artifact', async () => {
  const f = fixture()
  try {
    f.write({})
    const registry = new Registry(f.ctx, { clientArtifactManifest: f.file })
    assert.equal(registry.clientPath(f.id), join(f.dir, 'client.js'))
  } finally {
    await f.dispose()
  }
})

test('the override remains optional for other Harness consumers', async () => {
  const f = fixture()
  try {
    const registry = new Registry(f.ctx)
    assert.equal(registry.clientPath(f.id), join(f.dir, 'client.js'))
  } finally {
    await f.dispose()
  }
})

test('a missing owned artifact and an escaping path fail before scanning plugins', async () => {
  for (const path of ['missing.js', '../outside.js']) {
    const f = fixture()
    try {
      f.write({ [f.id]: { ...f.row, path } })
      assert.throws(
        () => new Registry(f.ctx, { clientArtifactManifest: f.file }),
        path === 'missing.js' ? /ENOENT/ : /escapes/,
      )
    } finally {
      await f.dispose()
    }
  }
})
