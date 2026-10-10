import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const read = (path: string) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
it('installs official optional bundles through the fixed Harness dependency tree', async () => {
  const desktopRequire = createRequire(
    new URL('../package.json', import.meta.url),
  )
  const harnessManifest = desktopRequire.resolve(
    '@superdsh/harness/package.json',
  )
  const harness = JSON.parse(readFileSync(harnessManifest, 'utf8'))
  const require = createRequire(harnessManifest)
  const { OPTIONAL_BUNDLES } = await import(
    pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href
  )
  for (const name of OPTIONAL_BUNDLES) {
    expect(harness.dependencies[name], name).toBe(
      harness.dependencies['@deepseek-ai/dsh-app-boot'],
    )
    const installed = JSON.parse(
      readFileSync(require.resolve(`${name}/package.json`), 'utf8'),
    )
    expect(installed.version, name).toBe(harness.dependencies[name])
    expect(installed.dsh?.bundle?.patch, name).toBeTruthy()
  }
})

it('ships the SuperDsh identity with native modules, explicit fuses and the Composer icon source', () => {
  const next = read('../package.json')
  const desktop = read('./fixtures/native-packaging-policy.json')
  expect(next.version).toBe('2.0.14')
  expect(next.build.appId).toBe('com.superdsh.desktop')
  expect(next.build.productName).toBe('SuperDsh')
  for (const name of ['core', 'ui', 'harness'])
    expect(next.dependencies[`@superdsh/${name}`]).toBe('workspace:*')
  expect(next.build.asar).toBe(false)
  expect(next.build.electronFuses).toEqual(desktop.electronFuses)
  expect(next.build.mac.x64ArchFiles).toBe(
    desktop.x64ArchFiles.replace(
      '**}',
      '**,@trycua/cua-driver-darwin-*/**,@ubjs/node-darwin-*/**}',
    ),
  )
  expect(next.build.mac.icon).toBe('build/app-icon.icon')
  expect(
    existsSync(new URL('../build/app-icon.icon/icon.json', import.meta.url)),
  ).toBe(true)
  expect(next.build.nsis).toMatchObject({
    oneClick: false,
    perMachine: false,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
  })
  expect(next.build.mac.notarize).toBe(true)
  expect(next.build.files).toContain('lib/**')
  expect(
    next.build.files.some((path: string) => path.includes('.desktop-next')),
  ).toBe(false)
  expect(next.build.win.artifactName).toBe(
    'SuperDsh-${version}-${arch}-Portable.${ext}',
  )
  expect(next.build.nsis.artifactName).toBe(
    'SuperDsh-${version}-${arch}-Setup.${ext}',
  )
})
