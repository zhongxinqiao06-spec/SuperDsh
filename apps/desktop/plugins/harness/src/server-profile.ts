/** Server composition keeps the complete Web Host APIs without the Electron bundle. */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  initProfile,
  loadProfileDirectory,
  type Profile,
} from '@deepseek-ai/dsh-app-boot'
import { atomicJson } from './private-files.ts'
import { HARNESS_PACKAGE, HARNESS_BUNDLE } from './profiles.ts'

export const SERVER_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
]

export function loadServerProfile(home: string): {
  profile: Profile
  installAnchor: string
  patchFiles: string[]
} {
  if (!isAbsolute(home)) throw new Error('Server Harness Home must be absolute')
  const profileDir = join(home, 'profiles', 'server-agent')
  for (const directory of [home, join(home, 'profiles'), profileDir]) {
    if (
      existsSync(directory) &&
      (!lstatSync(directory).isDirectory() ||
        lstatSync(directory).isSymbolicLink())
    )
      throw new Error('Server Harness profile requires real owned directories')
  }
  initProfile(profileDir, SERVER_BUNDLES)
  const modules = join(home, 'profiles', 'node_modules', '@superdsh')
  for (const directory of [dirname(modules), modules]) {
    if (
      existsSync(directory) &&
      (!lstatSync(directory).isDirectory() ||
        lstatSync(directory).isSymbolicLink())
    )
      throw new Error('Server Harness bundle scope must be a real directory')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  const link = join(modules, 'harness')
  const target = realpathSync(dirname(HARNESS_PACKAGE))
  const existing = lstatSync(link, { throwIfNoEntry: false })
  if (existing && !existing.isSymbolicLink())
    throw new Error('Server Harness bundle link is occupied')
  if (existing && resolve(dirname(link), readlinkSync(link)) !== target)
    unlinkSync(link)
  if (!lstatSync(link, { throwIfNoEntry: false }))
    symlinkSync(target, link, 'junction')
  const patch = join(profileDir, 'server-agent.runtime.patch.json')
  atomicJson(patch, [
    { id: 'webserver', config: { host: '127.0.0.1', port: 0 } },
    {
      id: 'web-runtime',
      config: {
        openBrowser: false,
        printUrl: false,
        surfaceContext: false,
        trustedHosts: [],
      },
    },
    {
      insert: [
        {
          id: 'superdsh-managed-bridge',
          name: HARNESS_BUNDLE + '/managed-bridge',
          config: {
            dshHome: home,
            stateRoot: join(home, 'platform-connector'),
          },
        },
        {
          id: 'superdsh-managed-models',
          name: HARNESS_BUNDLE + '/managed-models',
        },
      ],
    },
  ])
  const profile = loadProfileDirectory(
    'superdsh-server-agent',
    profileDir,
    HARNESS_PACKAGE,
  )
  if (
    !SERVER_BUNDLES.every((name) =>
      profile.layers.some((layer) => layer.packageName === name),
    )
  )
    throw new Error(
      'Server Harness profile is missing its required Host bundles',
    )
  return { profile, installAnchor: HARNESS_PACKAGE, patchFiles: [patch] }
}
