import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { installProfileDependencies } from '../src/profile-install.ts'
import { NextProfiles } from '../src/profiles.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})
it('installs a local imported dependency at its final path without executing package lifecycle scripts', async () => {
  const home = mkdtempSync(join(tmpdir(), 'superdsh-install-'))
  roots.push(home)
  const directory = new NextProfiles(home).ensure('desktop')
  const fixture = join(home, 'fixture')
  const marker = join(home, 'must-not-run')
  mkdirSync(fixture)
  writeFileSync(
    join(fixture, 'package.json'),
    JSON.stringify({
      name: 'superdsh-install-fixture',
      version: '1.0.0',
      scripts: { postinstall: 'node postinstall.cjs' },
    }),
  )
  writeFileSync(
    join(fixture, 'postinstall.cjs'),
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`,
  )
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name: 'imported-profile',
      private: true,
      dependencies: {
        'superdsh-install-fixture': `file:${fixture.replaceAll('\\', '/')}`,
      },
    }),
  )
  await installProfileDependencies({
    home,
    profiles: [{ name: 'desktop', directory }],
    ignoreScripts: true,
  })
  expect(
    existsSync(
      join(directory, 'node_modules/superdsh-install-fixture/package.json'),
    ),
  ).toBe(true)
  expect(existsSync(marker)).toBe(false)
  await expect(
    installProfileDependencies({
      home,
      profiles: [{ name: 'desktop', directory: fixture }],
      ignoreScripts: true,
    }),
  ).rejects.toThrow('target Home')
})
