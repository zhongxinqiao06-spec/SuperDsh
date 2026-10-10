/** Full Harness child: no Electron, SDK surrogate, or second task queue. */
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const anchor =
  process.env.SUPERDSH_HARNESS_PACKAGE ||
  fileURLToPath(
    new URL('../../desktop/plugins/harness/package.json', import.meta.url),
  )
const runtimeRequire = createRequire(anchor)
const load = (name) => import(pathToFileURL(runtimeRequire.resolve(name)).href)
const { loadLayeredEnv } = await load('@deepseek-ai/dsh-app-boot')
const { startHarnessHost } = await load('@superdsh/harness/host-runtime')
const { loadServerProfile } = await load('@superdsh/harness/server-profile')
const { bundledPnpmEntry } = await load('@superdsh/harness/extensions')
const { HARNESS_PACKAGE } = await load('@superdsh/harness/profiles')

const home = resolve(process.env.DSH_HOME || '/data/home')
const profile = loadServerProfile(home)
const application = startHarnessHost({
  environment: loadLayeredEnv('superdsh-server-agent'),
  profile: profile.profile.name,
  resolvedProfile: {
    profile: profile.profile,
    installAnchor: profile.installAnchor,
  },
  patchFiles: profile.patchFiles,
  args: ['--no-open', '--port', '0'],
  packageManager: {
    command: process.execPath,
    args: [
      '--expose-internals',
      bundledPnpmEntry(HARNESS_PACKAGE),
      '--config.minimumReleaseAge=0',
    ],
    env: { DSH_HOME: home },
  },
})
let stopping
function stop() {
  stopping ??= application.then((host) => host.shutdown(0)).catch(() => {})
  return stopping
}
process.once('SIGTERM', () => void stop())
process.once('SIGINT', () => void stop())
try {
  const host = await application
  await host.ready
  const deadline = Date.now() + 30000
  let bridge = host.ctx.get('agentsAnywhereRuntime')
  while (!bridge && Date.now() < deadline && !stopping) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    bridge = host.ctx.get('agentsAnywhereRuntime')
  }
  if (!bridge) throw new Error('Required server RuntimeBridge did not mount')
  const bridgeStatus = await bridge.restart()
  if (bridgeStatus.state !== 'ready')
    throw new Error(
      'Required server RuntimeBridge is unavailable: ' +
        (bridgeStatus.code || bridgeStatus.message),
    )
  // A line consumed by the local worker supervisor, never a user-facing authenticated URL.
  process.stdout.write('SUPERDSH_AGENT_HOST_READY\n')
} catch (error) {
  process.stderr.write(
    `Server Harness startup failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  )
  await stop()
  process.exitCode = 1
}
