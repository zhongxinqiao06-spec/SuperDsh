import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  readUpdateConfiguration,
  validateUpdateConfiguration,
} from '../../src/main/update-configuration.ts'
import { checkForDesktopUpdate } from '../../src/platform/shared/update-checker.ts'
import {
  assertAllowedDownloadOrigin,
  desktopUpdateFilename,
} from '../../src/platform/shared/update-download.ts'

const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0)) {
    const path = await realpath(home)
    if (
      !path.startsWith(`${await realpath(tmpdir())}${sep}`) ||
      !path.includes('superdsh-update-config-')
    )
      throw new Error('Unsafe test cleanup')
    await rm(path, { recursive: true, force: true })
  }
})
it('loads public product URLs and overlays explicit environment URL fields without importing secrets', async () => {
  const home = await mkdtemp(join(tmpdir(), 'superdsh-update-config-'))
  homes.push(home)
  const path = join(home, 'product-update.json')
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: 1,
      versionUrl: 'https://releases.example.test/version',
      downloadUrls: { win32: 'https://releases.example.test/windows' },
      allowedDownloadPrefixes: [],
    }),
  )
  const config = readUpdateConfiguration({
    path,
    env: {
      SUPERDSH_UPDATE_MAC_URL: 'https://releases.example.test/mac',
      PRIVATE_SIGNING_TOKEN: 'do-not-copy',
    },
  })
  expect(config?.downloadUrls).toEqual({
    win32: 'https://releases.example.test/windows',
    darwin: 'https://releases.example.test/mac',
  })
  expect(JSON.stringify(config)).not.toContain('do-not-copy')
  await writeFile(path, '{}')
  expect(readUpdateConfiguration({ path, env: {} })).toBeUndefined()
})
it('rejects credentials, HTTP endpoints and mirror hosts without repository path restrictions', () => {
  for (const versionUrl of [
    'http://release.example.test/version',
    'https://user:secret@release.example.test/version',
    'https://release.example.test/version#fragment',
  ]) {
    expect(() => validateUpdateConfiguration({ versionUrl })).toThrow()
  }
  expect(() =>
    validateUpdateConfiguration({
      versionUrl: 'https://release.example.test/version',
      allowedDownloadPrefixes: ['https://storage.example.test/'],
    }),
  ).toThrow()
})
it('performs no fallback request when an endpoint is absent or invalid', async () => {
  const request = vi.fn(async () => Response.json({ version: '2.0.15' }))
  for (const endpoint of [undefined, 'http://release.example.test/version']) {
    expect(
      await checkForDesktopUpdate({
        endpoint,
        currentVersion: '2.0.14',
        channel: 'stable',
        request,
      }),
    ).toBeNull()
  }
  expect(request).not.toHaveBeenCalled()
})
it('accepts only the configured exact endpoint and reviewed mirror path, with SuperDsh cache filenames', () => {
  const policy = {
    endpoint: 'https://release.example.test/mac',
    allowedPrefixes: ['https://storage.example.test/superdsh/releases/'],
  }
  expect(() =>
    assertAllowedDownloadOrigin(policy.endpoint, policy),
  ).not.toThrow()
  expect(() =>
    assertAllowedDownloadOrigin(
      'https://storage.example.test/superdsh/releases/SuperDsh.dmg',
      policy,
    ),
  ).not.toThrow()
  for (const url of [
    'https://release.example.test/other',
    'https://storage.example.test/superdsh/releases-evil/update.dmg',
    'https://storage.example.test/superdsh/releases/%2fsecret',
    'https://www.dshdesktop.cn/api/downloads/mac',
  ]) {
    expect(() => assertAllowedDownloadOrigin(url, policy)).toThrow()
  }
  expect(desktopUpdateFilename('win32', '2.0.15')).toBe(
    'SuperDsh-2.0.15-x64-Setup.exe',
  )
  expect(desktopUpdateFilename('darwin', '2.0.15')).toBe(
    'SuperDsh-2.0.15-universal.dmg',
  )
})
