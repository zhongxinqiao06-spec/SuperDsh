/** Reuse the signed universal DMG verifier with Next's application identity. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { verifyMacRelease } from './packaging/verify-mac-release.ts'
import { NEXT_MAC_NATIVE_ENTRIES } from './mac-runtime.ts'
import { nativeRuntimePath } from './native-runtime-path.ts'
import {
  macSmokeArchitecture,
  macSmokeExecutableSlices,
} from './packaging/mac-universal.ts'

export function verifyNextMac(signed: boolean): void {
  const slices = signed
    ? ['x86_64', 'arm64']
    : macSmokeExecutableSlices(macSmokeArchitecture(process.env))
  verifyMacRelease({
    distDir: resolve(
      process.argv[2] ?? `dist/${signed ? 'mac-release' : 'mac-smoke'}`,
    ),
    productName: 'SuperDsh',
    executableSlices: slices,
    nativeEntries: NEXT_MAC_NATIVE_ENTRIES.filter((entry) =>
      slices.includes(entry.arch),
    ),
    resolveNativeEntry: (root, entry) => nativeRuntimePath(root, entry),
    listDmgs: (path) =>
      readdirSync(path)
        .filter((name) => name.endsWith('.dmg'))
        .map((name) => join(path, name))
        .filter((path) => statSync(path).isFile()),
    makeMountPoint: () => mkdtempSync(join(tmpdir(), 'dsh-next-release-')),
    removeMountPoint: (path) => rmdirSync(path),
    run: (command, args) => {
      if (!signed && ['codesign', 'spctl', 'xcrun'].includes(command)) return
      const result = spawnSync(command, args, { stdio: 'inherit' })
      if (result.error || result.status !== 0)
        throw (
          result.error ?? new Error(`Artifact verification failed: ${command}`)
        )
    },
  })
}
if (process.argv[1]?.endsWith('/verify-mac-release.ts')) verifyNextMac(true)
