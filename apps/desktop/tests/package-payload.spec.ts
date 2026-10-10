import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { verifyNextPayload } from '../scripts/verify-packaged.ts'
import { nativeRuntimePath } from '../scripts/native-runtime-path.ts'

const fixtures: string[] = []
afterEach(() => {
  for (const path of fixtures.splice(0))
    rmSync(path, { recursive: true, force: true })
})
const write = (root: string, path: string, value: unknown = '') => {
  const file = join(root, path)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'superdsh-payload-'))
  fixtures.push(root)
  for (const file of [
    'LICENSE',
    'LICENSE.upstream',
    'lib/index.js',
    'lib/main.js',
    'lib/host.js',
    'lib/client.js',
    'lib/preload-app.cjs',
    'lib/preload-shell.cjs',
    'lib/preload-extension.cjs',
    'lib/native-ui/index.html',
    'cordis.patch.yml',
    'product-update.json',
    'scripts/node-bin/node',
    'scripts/node-bin/node.cmd',
    'assets/tray-iconTemplate.png',
    'assets/tray-icon-blue.png',
    'node_modules/@superdsh/core/lib/backend/host.js',
    'node_modules/@superdsh/harness/lib/host.js',
    'node_modules/@superdsh/harness/cordis.patch.yml',
    'node_modules/@superdsh/harness/host.cordis.patch.yml',
    'node_modules/@superdsh/core/lib/contracts/desktop-contract.js',
    'node_modules/@superdsh/ui/dist/index.html',
    'node_modules/@superdsh/ui/dist/compatibility.html',
    'node_modules/@superdsh/ui/client/fixture.js',
  ])
    write(root, file)
  write(root, 'package.json', {
    name: '@superdsh/desktop',
    dependencies: { '@superdsh/harness': '1' },
  })
  write(root, 'node_modules/@superdsh/harness/package.json', {
    name: '@superdsh/harness',
    dependencies: { fixture: '1' },
  })
  write(
    root,
    'node_modules/@superdsh/harness/node_modules/fixture/package.json',
    { name: 'fixture' },
  )
  write(root, 'node_modules/@superdsh/ui/client-manifest.json', {
    schemaVersion: 1,
    harnessVersion: '0.1.7-alpha.2',
    modules: { fixture: { path: 'client/fixture.js' } },
  })
  return root
}
it('accepts isolated Harness dependencies and rejects a missing required plugin peer', () => {
  const root = fixture()
  expect(() => verifyNextPayload(root)).not.toThrow()
  write(
    root,
    'node_modules/@superdsh/harness/node_modules/fixture/package.json',
    { name: 'fixture', peerDependencies: { 'missing-peer': '1' } },
  )
  expect(() => verifyNextPayload(root)).toThrow(
    'Missing packaged dependency missing-peer required by fixture',
  )
})
it('rejects missing frontend artifacts and paths outside the owned frontend package', () => {
  const root = fixture()
  write(root, 'node_modules/@superdsh/ui/client-manifest.json', {
    schemaVersion: 1,
    harnessVersion: '0.1.7-alpha.2',
    modules: { fixture: { path: '../harness/lib/host.js' } },
  })
  expect(() => verifyNextPayload(root)).toThrow('escapes frontend')
  write(root, 'node_modules/@superdsh/ui/client-manifest.json', {
    schemaVersion: 1,
    harnessVersion: '0.1.7-alpha.2',
    modules: { fixture: { path: 'missing.js' } },
  })
  expect(() => verifyNextPayload(root)).toThrow()
})
it('finds native files in Harness and rejects a packaged native link to workspace data', () => {
  const root = fixture()
  write(
    root,
    'node_modules/@superdsh/harness/node_modules/native-fixture/runtime.node',
  )
  expect(
    nativeRuntimePath(root, 'node_modules/native-fixture/runtime.node'),
  ).toContain('harness')
  const external = mkdtempSync(join(tmpdir(), 'superdsh-native-external-'))
  fixtures.push(external)
  write(external, 'runtime.node')
  symlinkSync(
    external,
    join(root, 'node_modules/external-native'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  expect(() =>
    nativeRuntimePath(root, 'node_modules/external-native/runtime.node'),
  ).toThrow('escapes')
  expect(
    nativeRuntimePath(root, 'node_modules/external-native/runtime.node', true),
  ).toBe(join(external, 'runtime.node'))
})
