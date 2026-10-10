import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  frontendDocumentPaths,
  frontendRuntimePatch,
} from '../src/frontend-manifest.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})
function fixture(
  path = 'client/entry.js',
  version = '0.1.7-alpha.2',
  staticRoot = 'dist',
) {
  const root = mkdtempSync(join(tmpdir(), 'superdsh-frontend-'))
  roots.push(root)
  mkdirSync(join(root, 'client'))
  writeFileSync(join(root, 'client/entry.js'), '/* built client */')
  mkdirSync(join(root, 'dist'))
  writeFileSync(join(root, 'dist/index.html'), '<title>SuperDsh</title>')
  writeFileSync(
    join(root, 'dist/compatibility.html'),
    '<title>SuperDsh Extensions</title>',
  )
  const manifest = join(root, 'client-manifest.json')
  writeFileSync(
    manifest,
    JSON.stringify({
      schemaVersion: 1,
      harnessVersion: version,
      staticRoot,
      modules: { fixture: { path } },
    }),
  )
  return manifest
}
it('configures both dynamic modules and the real Host static frontend from owned artifacts', () => {
  const manifest = fixture()
  expect(frontendRuntimePatch(manifest, ['fixture.example'])).toEqual([
    { id: 'modules', config: { clientArtifactManifest: manifest } },
    {
      id: 'web-runtime',
      config: {
        frontendIndex: join(dirname(manifest), 'dist/index.html'),
        openBrowser: false,
        printUrl: true,
        surfaceContext: true,
        trustedHosts: ['fixture.example'],
      },
    },
  ])
})
it('rejects absent, mismatched and escaped artifacts instead of falling back to upstream client sources', () => {
  expect(() => frontendRuntimePatch(undefined)).toThrow('absolute')
  expect(() =>
    frontendRuntimePatch(fixture('client/entry.js', 'other')),
  ).toThrow('Unsupported')
  expect(() => frontendRuntimePatch(fixture('../outside.js'))).toThrow(
    'outside',
  )
  expect(() => frontendRuntimePatch(fixture('client/missing.js'))).toThrow()
  expect(() =>
    frontendRuntimePatch(
      fixture('client/entry.js', '0.1.7-alpha.2', '../outside'),
    ),
  ).toThrow()
  expect(() =>
    frontendRuntimePatch(
      fixture('client/entry.js', '0.1.7-alpha.2', 'missing'),
    ),
  ).toThrow()
})

it('requires the authenticated compatibility document in the owned static root', () => {
  const manifest = fixture()
  expect(frontendDocumentPaths(manifest).compatibilityIndex).toBe(
    join(dirname(manifest), 'dist/compatibility.html'),
  )
  rmSync(join(dirname(manifest), 'dist/compatibility.html'))
  expect(() => frontendRuntimePatch(manifest)).toThrow()
})

it('rejects a static directory junction that redirects documents outside their manifest', () => {
  const manifest = fixture()
  const other = fixture()
  const localStatic = join(dirname(manifest), 'dist')
  rmSync(localStatic, { recursive: true })
  symlinkSync(
    join(dirname(other), 'dist'),
    localStatic,
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  expect(() => frontendDocumentPaths(manifest)).toThrow('outside')
})
