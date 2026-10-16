/** Full Harness child: no Electron, SDK substitute, Python, or second execution queue. */
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { connectBusinessAgents } from '../agents/host-plugin.mjs'

const anchor = fileURLToPath(
  new URL('../../../desktop/plugins/harness/package.json', import.meta.url),
)
const runtimeRequire = createRequire(anchor)
const load = (name) => import(pathToFileURL(runtimeRequire.resolve(name)).href)
const { loadLayeredEnv } = await load('@deepseek-ai/dsh-app-boot')
const { startHarnessHost } = await load('@superdsh/harness/host-runtime')
const { loadServerProfile } = await load('@superdsh/harness/server-profile')
const { bundledPnpmEntry } = await load('@superdsh/harness/extensions')
const { HARNESS_PACKAGE } = await load('@superdsh/harness/profiles')
const home = resolve(process.env.DSH_HOME)
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
connectBusinessAgents(application)
let stopping
function stop() {
  stopping ??= application.then((host) => host.shutdown(0)).catch(() => {})
  return stopping
}
process.once('SIGTERM', () => void stop())
process.once('SIGINT', () => void stop())
process.once('disconnect', () => void stop())
process.on('message', (message) => {
  if (message?.type === 'shutdown') void stop()
  if (message?.type === 'refresh-models')
    void application
      .then((host) => host.ctx.get('superdshManagedModels')?.refresh())
      .catch(() => {})
})
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
  const status = await bridge.restart()
  if (status.state !== 'ready')
    throw new Error('Required server RuntimeBridge is unavailable')
  process.send?.({ type: 'host-ready' })
} catch {
  process.send?.({ type: 'host-error', code: 'harness-startup-failed' })
  await stop()
  process.exitCode = 1
}
