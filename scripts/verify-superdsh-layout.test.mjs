import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { test } from 'node:test'
import { imports, verifySuperdshLayout } from './verify-superdsh-layout.mjs'
import {
  architecturePackages,
  verifyDependencyBoundaries,
} from './workspace-layout.mjs'

const version = '0.1.7-alpha.2'
test('module scanner ignores syntax examples in strings and comments', () => {
  assert.deepEqual(
    imports(
      `const grammar = 'from "fictional-package"'; // import x from 'comment-only';\nimport real from 'real'; export { thing } from 'second'; const third = require('third');`,
    ),
    ['real', 'second', 'third'],
  )
})
function fixture(t) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'superdsh-layout-test-')),
  )
  t.after(() => {
    assert.ok(realpathSync(root).startsWith(`${realpathSync(tmpdir())}${sep}`))
    assert.ok(root.includes('superdsh-layout-test-'))
    rmSync(root, { recursive: true, force: true })
  })
  const write = (path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(
      join(root, path),
      typeof value === 'string' ? value : JSON.stringify(value),
    )
  }
  const read = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'))
  const resolution = `patch:@deepseek-ai/dsh-client-modules@file%3Avendor/dsh-runtime/${version}/modules.tgz#./patches/superdsh-client-modules.patch`
  write('package.json', {
    workspaces: Object.keys(architecturePackages),
    scripts: Object.fromEntries(
      ['dev', 'build', 'typecheck', 'test', 'check'].map((name) => [
        name,
        'yarn workspace @superdsh/desktop check',
      ]),
    ),
    resolutions: {
      [`@deepseek-ai/dsh-client-modules@npm:${version}`]: resolution,
      [`@deepseek-ai/dsh-client-modules@npm:^${version}`]: resolution,
    },
  })
  write('upstream.json', {
    activeChannel: 'stable',
    channels: { stable: { runtimePackageVersion: version } },
  })
  write('patches/superdsh-client-modules.patch', 'pinned test patch')
  for (const [path, name] of Object.entries(architecturePackages)) {
    const required =
      name === '@superdsh/desktop'
        ? ['core', 'ui', 'harness']
        : name === '@superdsh/core'
          ? ['harness']
          : []
    write(`${path}/package.json`, {
      name,
      private: true,
      devDependencies:
        name === '@superdsh/harness' ? { '@superdsh/core': 'workspace:*' } : {},
      exports: { '.': './lib/index.js' },
      dependencies: Object.fromEntries(
        required.map((name) => [`@superdsh/${name}`, 'workspace:*']),
      ),
    })
    write(`${path}/src/index.ts`, 'export const ready = true\n')
    write(`${path}/lib/index.js`, 'export const ready = true;\n')
  }
  for (const path of [
    'apps/desktop/core/lib/main/main.js',
    'apps/desktop/core/lib/preload/preload-app.cjs',
    'apps/desktop/core/lib/preload/preload-shell.cjs',
    'apps/desktop/ui/native-ui/index.html',
    'apps/desktop/core/lib/backend/host.js',
    'apps/desktop/plugins/harness/lib/host.js',
    'apps/desktop/plugins/harness/host.cordis.patch.yml',
  ])
    write(path, '')
  const input = 'src/client.ts',
    contents = 'export const client = true\n'
  const id = '@deepseek-ai/dsh-client-locale'
  const sourceDigest = createHash('sha256')
    .update(input)
    .update(contents)
    .digest('hex')
  write(`apps/desktop/ui/${input}`, contents)
  write('apps/desktop/ui/source-manifest.json', {
    schemaVersion: 1,
    harnessVersion: version,
    modules: { [id]: { entry: input, external: [], inject: [] } },
  })
  write('apps/desktop/ui/client-manifest.json', {
    schemaVersion: 1,
    harnessVersion: version,
    sourceDigest,
    staticRoot: 'dist',
    buildSources: 'build-sources.json',
    modules: {
      [id]: { path: 'client/locale/client.js', external: [], inject: [] },
    },
  })
  write('apps/desktop/ui/build-sources.json', {
    sourceDigest,
    modules: { [id]: [input] },
  })
  write('apps/desktop/ui/client/locale/client.js', 'window.client = true')
  write('apps/desktop/ui/dist/index.html', '<html></html>')
  return { root, write, read, id }
}

test('accepts separated source and built manifests without requiring legacy applications', (t) => {
  const { root, write } = fixture(t)
  write(
    'apps/desktop/core/src/migration.ts',
    'const oldName = "dsh-desktop-next"; export { oldName }',
  )
  assert.deepEqual(verifySuperdshLayout(root), {
    packages: 5,
    sourceOnly: false,
  })
})

test('permits only declared owned workspace references and refuses Harness source bypasses', () => {
  const packages = [
    {
      path: 'apps/desktop/core',
      manifest: { name: '@superdsh/backend', private: true },
    },
  ]
  assert.doesNotThrow(() =>
    verifyDependencyBoundaries(
      { dependencies: { '@superdsh/backend': 'workspace:*' } },
      packages,
    ),
  )
  for (const [name, range] of [
    ['@deepseek-ai/dsh', 'workspace:*'],
    ['@superdsh/missing', 'workspace:*'],
    ['@deepseek-ai/dsh', 'file:deepseek-harness'],
    ['@deepseek-ai/dsh-session', 'file:../outside.tgz'],
    ['arbitrary', 'portal:./deepseek-harness'],
  ]) {
    assert.throws(
      () =>
        verifyDependencyBoundaries(
          { dependencies: { [name]: range } },
          packages,
        ),
      /boundary|recorded Harness vendor/,
    )
  }
})

test('rejects direct old application imports while accepting migration identifiers', (t) => {
  const { root, write } = fixture(t)
  write(
    'apps/desktop/core/src/index.ts',
    'export { createRuntime } from "../../../dsh-desktop-next/src/runtime.ts"',
  )
  assert.throws(
    () => verifySuperdshLayout(root, { sourceOnly: true }),
    /imports a legacy/,
  )
})

test('checks aliases reached by default commands, leaving explicit legacy commands available', (t) => {
  const { root, write, read } = fixture(t)
  const workspace = read('package.json')
  workspace.scripts['build:legacy'] = 'yarn workspace dsh-plugin-desktop build'
  write('package.json', workspace)
  assert.doesNotThrow(() => verifySuperdshLayout(root, { sourceOnly: true }))
  workspace.scripts.build = 'yarn build:legacy'
  write('package.json', workspace)
  assert.throws(
    () => verifySuperdshLayout(root, { sourceOnly: true }),
    /legacy desktop/,
  )
})

test('source-only validation succeeds before builds but the complete gate rejects missing artifacts', (t) => {
  const { root } = fixture(t)
  unlinkSync(join(root, 'apps/desktop/ui/client/locale/client.js'))
  assert.doesNotThrow(() => verifySuperdshLayout(root, { sourceOnly: true }))
  assert.throws(
    () => verifySuperdshLayout(root),
    /missing or unsafe built artifact/,
  )
})

test('rejects stale browser artifacts and unresolved client manifest externals', (t) => {
  const { root, write, read, id } = fixture(t)
  write('apps/desktop/ui/src/client.ts', 'export const client = false')
  assert.throws(
    () => verifySuperdshLayout(root),
    /changed after the last build/,
  )
  const source = read('apps/desktop/ui/source-manifest.json'),
    built = read('apps/desktop/ui/client-manifest.json')
  source.modules[id].external = built.modules[id].external = [
    '@deepseek-ai/dsh-missing/client',
  ]
  write('apps/desktop/ui/source-manifest.json', source)
  write('apps/desktop/ui/client-manifest.json', built)
  assert.throws(() => verifySuperdshLayout(root), /missing external/)
})

test('rejects built imports hidden in undeclared dependencies and accepts an explicit runtime edge', (t) => {
  const { root, write, read } = fixture(t)
  write(
    'apps/desktop/core/lib/index.js',
    'import YAML from "yaml"; export { YAML }',
  )
  assert.throws(
    () => verifySuperdshLayout(root),
    /undeclared runtime dependency yaml/,
  )
  const manifest = read('apps/desktop/core/package.json')
  manifest.dependencies.yaml = '^2.9.0'
  write('apps/desktop/core/package.json', manifest)
  assert.doesNotThrow(() => verifySuperdshLayout(root))
})

test('rejects removing the client registry patch from Yarn resolutions', (t) => {
  const { root, write, read } = fixture(t)
  const manifest = read('package.json')
  delete manifest.resolutions[`@deepseek-ai/dsh-client-modules@npm:${version}`]
  write('package.json', manifest)
  assert.throws(
    () => verifySuperdshLayout(root, { sourceOnly: true }),
    /client registry patch/,
  )
})

test('rejects UI and Harness reaching core implementation while allowing pure contracts', (t) => {
  const { root, write } = fixture(t)
  write(
    'apps/desktop/ui/src/index.ts',
    "import type { State } from '@superdsh/core/contracts/state'",
  )
  assert.doesNotThrow(() => verifySuperdshLayout(root, { sourceOnly: true }))
  for (const specifier of [
    '@superdsh/core/backend',
    '../../core/src/backend/host.ts',
  ]) {
    write('apps/desktop/ui/src/index.ts', `import { Host } from '${specifier}'`)
    assert.throws(
      () => verifySuperdshLayout(root, { sourceOnly: true }),
      /UI must import only pure core contracts/,
    )
  }
  write('apps/desktop/ui/src/index.ts', '')
  write(
    'apps/desktop/plugins/harness/src/index.ts',
    "import { Host } from '@superdsh/core/main/main'",
  )
  assert.throws(
    () => verifySuperdshLayout(root, { sourceOnly: true }),
    /Harness must import only pure core contracts/,
  )
})

test('rejects core presentation imports and a Harness runtime cycle', (t) => {
  const { root, write, read } = fixture(t)
  write('apps/desktop/core/src/index.ts', "import { App } from '@superdsh/ui'")
  assert.throws(
    () => verifySuperdshLayout(root, { sourceOnly: true }),
    /must not import presentation/,
  )
  write('apps/desktop/core/src/index.ts', '')
  const harness = read('apps/desktop/plugins/harness/package.json')
  harness.dependencies['@superdsh/core'] = 'workspace:*'
  write('apps/desktop/plugins/harness/package.json', harness)
  assert.throws(
    () => verifySuperdshLayout(root, { sourceOnly: true }),
    /runtime cycle/,
  )
})

test('browser core APIs remain free of Node and engine implementations', (t) => {
  const { root, write } = fixture(t)
  write(
    'apps/desktop/ui/src/index.ts',
    "import { client } from '@superdsh/core/client/settings'",
  )
  write('apps/desktop/core/src/client/settings.ts', 'export const client = {}')
  assert.doesNotThrow(() => verifySuperdshLayout(root, { sourceOnly: true }))
  for (const specifier of [
    'node:fs',
    'electron',
    '@superdsh/harness',
    '@superdsh/core/backend',
    '../../backend/host.ts',
  ]) {
    write(
      'apps/desktop/core/src/client/settings.ts',
      `import { api } from '${specifier}'`,
    )
    assert.throws(
      () => verifySuperdshLayout(root, { sourceOnly: true }),
      /browser core client imports a server implementation/,
    )
  }
})

test('browser digest includes safe inlined Core artifacts and rejects Host inputs', (t) => {
  const { root, write, read } = fixture(t)
  const records = read('apps/desktop/ui/build-sources.json')
  records.modules.core = ['../core/lib/client/settings.js']
  write('apps/desktop/core/lib/client/settings.js', 'export const state = 1')
  write('apps/desktop/ui/build-sources.json', records)
  assert.throws(
    () => verifySuperdshLayout(root),
    /changed after the last build/,
  )
  records.modules.core = ['../core/lib/backend/host.js']
  write('apps/desktop/ui/build-sources.json', records)
  assert.throws(() => verifySuperdshLayout(root), /non-browser core artifact/)
})
