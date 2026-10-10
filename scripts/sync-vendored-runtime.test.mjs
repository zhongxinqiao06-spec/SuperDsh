import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

const name = '@deepseek-ai/dsh-session'
const version = '0.1.7-alpha.2'
const nextVersion = '0.1.6-alpha.2'
const filename = `deepseek-ai-dsh-session-${version}.tgz`

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-sync-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (path, data) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(
      join(root, path),
      typeof data === 'string' ? data : JSON.stringify(data),
    )
  }
  const read = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'))
  write('upstream.json', {
    repository: 'https://example.test/harness.git',
    activeChannel: 'stable',
    channels: {
      stable: {
        commit: 'a'.repeat(40),
        sourceVersion: version,
        package: 'dsh-plugin-desktop',
      },
    },
  })
  write('package.json', {
    workspaces: [
      'dsh-community-market',
      'apps/desktop',
      'apps/desktop/core',
      'apps/desktop/ui',
      'apps/desktop/plugins/harness',
    ],
    resolutions: {
      [`${name}@npm:0.1.5-rc.2`]: 'file:obsolete.tgz',
      [`${name}@npm:${nextVersion}`]: 'file:next-runtime.tgz',
      unrelated: '1.0.0',
    },
  })
  for (const workspace of ['dsh-plugin-desktop', 'dsh-community-market']) {
    write(`${workspace}/package.json`, {
      name: workspace,
      dependencies: { [name]: '0.1.5-rc.2' },
    })
  }
  for (const [path, packageName] of [
    ['apps/desktop', '@superdsh/desktop'],
    ['apps/desktop/core', '@superdsh/core'],
    ['apps/desktop/ui', '@superdsh/ui'],
    ['apps/desktop/plugins/harness', '@superdsh/harness'],
  ]) {
    write(`${path}/package.json`, {
      name: packageName,
      private: true,
      dependencies: { [name]: '0.1.5-rc.2' },
    })
  }
  write('dsh-desktop-next/upstream-reference.json', { version: nextVersion })
  write('deepseek-harness/dist/npm/publish-order.txt', `${filename}\n`)
  write(`deepseek-harness/dist/npm/${filename}`, 'packed runtime fixture')
  mkdirSync(join(root, 'scripts'))
  copyFileSync(
    new URL('./sync-vendored-runtime.mjs', import.meta.url),
    join(root, 'scripts/sync-vendored-runtime.mjs'),
  )
  copyFileSync(
    new URL('./workspace-layout.mjs', import.meta.url),
    join(root, 'scripts/workspace-layout.mjs'),
  )
  const run = (...args) =>
    spawnSync(
      process.execPath,
      ['scripts/sync-vendored-runtime.mjs', ...args],
      { cwd: root, encoding: 'utf8' },
    )
  return { root, write, read, run }
}

test('runtime sync updates owned packages and Market without touching archived manifests and removes obsolete families', (t) => {
  const { read, run } = fixture(t)
  const result = run('--write')
  assert.equal(result.status, 0, result.stderr)
  for (const workspace of [
    'apps/desktop',
    'apps/desktop/core',
    'apps/desktop/ui',
    'apps/desktop/plugins/harness',
    'dsh-community-market',
  ]) {
    assert.equal(read(`${workspace}/package.json`).dependencies[name], version)
  }
  assert.equal(
    read('dsh-plugin-desktop/package.json').dependencies[name],
    '0.1.5-rc.2',
  )
  const resolutions = read('package.json').resolutions
  assert.equal(resolutions[`${name}@npm:0.1.5-rc.2`], undefined)
  assert.equal(resolutions[`${name}@npm:${nextVersion}`], undefined)
  assert.equal(
    resolutions[`${name}@npm:${version}`],
    `file:vendor/dsh-runtime/${version}/${filename}`,
  )
  assert.equal(resolutions.unrelated, '1.0.0')
  assert.equal(
    read('upstream.json').channels.stable.runtimePackageVersion,
    version,
  )
  assert.equal(run('--check').status, 0)
})

test('removed legacy mode fails before updating files', (t) => {
  const { read, run } = fixture(t)
  const before = read('package.json')
  const result = run('--write', '--legacy')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Legacy desktop workspaces were removed/)
  assert.deepEqual(read('package.json'), before)
})

test('sync preserves the product client registry patch instead of resetting it to the official tarball', (t) => {
  const { read, write, run } = fixture(t)
  const moduleName = '@deepseek-ai/dsh-client-modules'
  const moduleFile = `deepseek-ai-dsh-client-modules-${version}.tgz`
  write(
    'deepseek-harness/dist/npm/publish-order.txt',
    `${filename}\n${moduleFile}\n`,
  )
  write(`deepseek-harness/dist/npm/${moduleFile}`, 'client modules tarball')
  write(
    'patches/superdsh-client-modules.patch',
    `+ if (manifest.harnessVersion !== "${version}") throw new Error('version');\n`,
  )
  assert.equal(run('--write').status, 0)
  const expected = `patch:${moduleName}@file%3Avendor/dsh-runtime/${version}/${moduleFile}#./patches/superdsh-client-modules.patch`
  assert.equal(
    read('package.json').resolutions[`${moduleName}@npm:${version}`],
    expected,
  )
  assert.equal(
    read('package.json').resolutions[`${moduleName}@npm:^${version}`],
    expected,
  )
  assert.equal(run('--check').status, 0)
  write('patches/superdsh-client-modules.patch', '+ wrong runtime version\n')
  const before = read('package.json'),
    metadata = read('upstream.json')
  assert.match(run('--write').stderr, /must be reviewed/)
  assert.deepEqual(read('package.json'), before)
  assert.deepEqual(read('upstream.json'), metadata)
})

test('check rejects obsolete runtime selectors outside the pinned runtime family', (t) => {
  const { read, write, run } = fixture(t)
  assert.equal(run('--write').status, 0)
  const manifest = read('package.json')
  manifest.resolutions[`${name}@npm:0.1.5-rc.2`] = 'file:obsolete.tgz'
  write('package.json', manifest)
  const result = run('--check')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /obsolete DSH resolution/)
})

test('sync requires and retains the session-local platform model selection patch', (t) => {
  const { read, write, run } = fixture(t)
  const modelPackage = '@deepseek-ai/dsh-api-session-controller'
  const modelFile = `deepseek-ai-dsh-api-session-controller-${version}.tgz`
  const patch = `patches/dsh-api-session-controller@${version}.patch`
  write(
    'deepseek-harness/dist/npm/publish-order.txt',
    `${filename}\n${modelFile}\n`,
  )
  write(`deepseek-harness/dist/npm/${modelFile}`, 'session controller tarball')
  const before = read('package.json')
  assert.match(run('--write').stderr, /missing required SuperDsh session-local/)
  assert.deepEqual(read('package.json'), before)
  write(patch, 'pinned product model-selection patch')
  assert.equal(run('--write').status, 0)
  const expected = `patch:${modelPackage}@file%3Avendor/dsh-runtime/${version}/${modelFile}#./${patch}`
  for (const range of [version, `^${version}`])
    assert.equal(
      read('package.json').resolutions[`${modelPackage}@npm:${range}`],
      expected,
    )
  assert.equal(run('--check').status, 0)
})

test('the removed beta channel fails before updating files', (t) => {
  const { read, run } = fixture(t)
  const before = read('package.json')
  const result = run('--write', '--channel', 'beta')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /unknown release channel/)
  assert.deepEqual(read('package.json'), before)
})
