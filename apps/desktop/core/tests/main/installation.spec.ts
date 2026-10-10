import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import {
  desktopInstallationPackage,
  desktopRuntimeAssets,
} from '../../src/main/installation.ts'
const fixtures: string[] = []
afterEach(() => {
  for (const directory of fixtures.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

it('finds its enclosing assembly and resolves only the assembly-selected UI files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'superdsh-installation-'))
  fixtures.push(directory)
  const manifest = join(directory, 'package.json')
  const nested = join(directory, 'node_modules/core/lib/main')
  mkdirSync(nested, { recursive: true })
  for (const filename of ['page.html', 'manifest.json', 'native.html'])
    writeFileSync(join(directory, filename), '')
  writeFileSync(
    manifest,
    JSON.stringify({
      name: '@superdsh/desktop',
      superdsh: {
        runtimeAssets: {
          frontendIndex: './page.html',
          frontendManifest: './manifest.json',
          nativeIndex: './native.html',
        },
      },
    }),
  )
  expect(
    desktopInstallationPackage(
      pathToFileURL(join(nested, 'installation.js')).href,
    ),
  ).toBe(manifest)
  expect(desktopRuntimeAssets(manifest)).toEqual({
    frontendIndex: join(directory, 'page.html'),
    frontendManifest: join(directory, 'manifest.json'),
    nativeIndex: join(directory, 'native.html'),
  })
  writeFileSync(manifest, JSON.stringify({ name: '@superdsh/desktop' }))
  expect(() => desktopRuntimeAssets(manifest)).toThrow(
    'not configured: frontendIndex',
  )
})
