import { resolve } from 'node:path'
import { bundledPnpmEntry, createPackageRunner } from './extensions.ts'
import { HARNESS_PACKAGE, NextProfiles } from './profiles.ts'
import { withDesktopPnpmPolicy } from './pnpm-policy.ts'

/** Installation runs after the import transaction has published its guarded final path. */
export interface ProfileDependencyRequest {
  home: string
  profiles: readonly { name: string; directory: string }[]
  ignoreScripts: true
  signal?: AbortSignal
}

/** Install declared profile dependencies without loading plugins or running package lifecycle scripts. */
export async function installProfileDependencies(
  request: ProfileDependencyRequest,
): Promise<void> {
  if (request.ignoreScripts !== true)
    throw new Error(
      'Imported Profile installation requires lifecycle scripts to be disabled',
    )
  const profiles = new NextProfiles(request.home)
  for (const profile of request.profiles) {
    request.signal?.throwIfAborted()
    const directory = profiles.directory(profile.name)
    if (directory !== resolve(profile.directory))
      throw new Error('Imported Profile must belong to the target Home')
    const runner = createPackageRunner(
      {
        command: process.execPath,
        args: [
          '--expose-internals',
          bundledPnpmEntry(HARNESS_PACKAGE),
          ...withDesktopPnpmPolicy([]),
        ],
        env: {
          DSH_HOME: request.home,
          DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
          ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        },
      },
      directory,
    )
    try {
      const install = runner.run(
        ['install', '--ignore-scripts', '--ignore-pnpmfile'],
        request.signal,
      )
      // Capture a bounded failure tail; do not expose credentials or dependency output to renderer state.
      let output = ''
      const append = (chunk: Buffer): void => {
        output = (output + chunk.toString()).slice(-16_384)
      }
      install.stdout.on('data', append)
      install.stderr.on('data', append)
      const result = await install.done
      request.signal?.throwIfAborted()
      if (result.exitCode !== 0) {
        const error = new Error(
          `Could not install dependencies for imported Profile ${profile.name}`,
        )
        // The native caller can record the cause privately after applying its normal secret masking.
        error.cause = new Error(
          output ||
            `pnpm exited with ${String(result.exitCode)} (${String(result.signal)})`,
        )
        throw error
      }
    } finally {
      await runner.dispose()
    }
  }
}
