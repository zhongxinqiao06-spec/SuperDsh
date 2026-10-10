import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { verifyElectronExecutableFuses } from './packaging/verify-electron-fuses.ts'
import { withoutMacReleaseSecrets } from './packaging/release-preflight.ts'
import { withoutWindowsSigningSecrets } from './packaging/package-win.ts'
export default async function afterAllArtifactBuild(result: {
  outDir: string
}): Promise<string[]> {
  const paths = [
    'mac/SuperDsh.app/Contents/MacOS/SuperDsh',
    'mac-arm64/SuperDsh.app/Contents/MacOS/SuperDsh',
    'mac-universal/SuperDsh.app/Contents/MacOS/SuperDsh',
    'win-unpacked/SuperDsh.exe',
    'linux-unpacked/superdsh',
  ]
  const executables = paths
    .map((path) => join(result.outDir, path))
    .filter(existsSync)
  if (!executables.length)
    throw new Error('No packaged SuperDsh executable to verify')
  for (const path of executables) {
    await verifyElectronExecutableFuses(path, undefined, false)
    const root = path.includes('.app/')
      ? join(dirname(path), '../Resources/app')
      : join(dirname(path), 'resources/app')
    const smoke = spawnSync(
      path,
      [
        '--input-type=module',
        '-e',
        `
      import { createRequire } from 'node:module';
      import { pathToFileURL } from 'node:url';
      const root = process.argv[1];
      const require = createRequire(root + '/package.json');
      if (require('./package.json').name !== '@superdsh/desktop') throw new Error('Wrong packaged application');
      await import(pathToFileURL(root + '/lib/profiles.js'));
      await import(pathToFileURL(root + '/lib/desktop-runtime.js'));
      require.resolve('@superdsh/core/backend/host');
      require.resolve('@superdsh/harness/host');
      require.resolve('@superdsh/ui/client-manifest.json');
    `,
        root,
      ],
      {
        env: {
          ...withoutWindowsSigningSecrets(
            withoutMacReleaseSecrets(process.env),
          ),
          ELECTRON_RUN_AS_NODE: '1',
        },
        timeout: 30_000,
        encoding: 'utf8',
      },
    )
    if (smoke.error || smoke.status !== 0)
      throw (
        smoke.error ??
        new Error(`Packaged SuperDsh runtime failed: ${smoke.stderr}`)
      )
  }
  return []
}
