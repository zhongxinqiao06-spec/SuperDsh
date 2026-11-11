/** 固定产品 Host 的装配与传输壳；不包含 HTTP 服务或平台业务实现。 */
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'
import { installTools } from './tools.ts'
import { installPresets } from './presets.ts'
import { fields } from './contracts.ts'
import type { Fields, Host } from './contracts.ts'
import { startupDiagnostic, type StartupStage } from './startup-diagnostics.ts'

const anchor = process.env.WEB_ADMIN_HARNESS_ANCHOR
const ownedHome = process.env.DSH_HOME
if (!anchor || !ownedHome)
  throw new Error('Harness installation anchor and Home are required')
const runtimeRequire = createRequire(anchor)
const load = (name: string): Promise<unknown> =>
  import(pathToFileURL(runtimeRequire.resolve(name)).href)
const { loadLayeredEnv } = (await load('@deepseek-ai/dsh-app-boot')) as {
  loadLayeredEnv(name: string): unknown
}
const { startHarnessHost } = (await load('@superdsh/harness/host-runtime')) as {
  startHarnessHost(options: unknown): Promise<Host>
}
const { loadServerProfile } = (await load(
  '@superdsh/harness/server-profile',
)) as {
  loadServerProfile(home: string): {
    profile: { name: string }
    installAnchor: string
    patchFiles: string[]
  }
}
const { bundledPnpmEntry } = (await load('@superdsh/harness/extensions')) as {
  bundledPnpmEntry(anchor: string): string
}
const { HARNESS_PACKAGE } = (await load('@superdsh/harness/profiles')) as {
  HARNESS_PACKAGE: string
}
const home = resolve(ownedHome)
const profile = loadServerProfile(home)
const send = (frame: Fields) => {
  process.stdout.write(`@@superdsh-runtime@@${JSON.stringify(frame)}\n`)
}
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
let stopping: Promise<void> | undefined
function stop(): Promise<void> {
  stopping ??= application
    .then((host) => host.shutdown(0))
    .catch((error) => {
      send({
        type: 'host-error',
        code: 'harness-startup-failed',
        diagnostic: startupDiagnostic('host-stop', error),
      })
      process.exitCode = 1
    })
  return stopping
}
const commands = createInterface({ input: process.stdin, crlfDelay: Infinity })
const tools = installTools(application, load, send)
const presets = installPresets(application, send)
commands.on('line', (line) => {
  if (Buffer.byteLength(line) > 8 * 1024 * 1024) return void stop()
  let message: Fields
  try {
    message = fields(JSON.parse(line))
  } catch {
    return void stop()
  }
  if (message.type === 'shutdown') void stop()
  else if (
    message.type === 'runtime-defaults' &&
    typeof message.id === 'string'
  )
    void application
      .then((host) => {
        // 每次读取引擎公开配置，不缓存权限默认值，也不依据目录顺序猜测权限。
        const preset = host.ctx.get('permissionPresets')?.defaultPreset
        if (!preset) throw new Error('Permission default unavailable')
        send({
          type: 'runtime-defaults',
          id: message.id,
          defaults: { permissionPreset: preset },
        })
      })
      .catch(() =>
        send({ type: 'runtime-defaults', id: message.id, error: true }),
      )
  else if (message.type === 'refresh-models')
    void application
      .then((host) => host.ctx.get('superdshManagedModels')?.refresh())
      .catch(() => send({ type: 'models-error' }))
  else if (!presets.accept(message)) tools.accept(message)
})
commands.once('close', () => void stop())
process.once('SIGTERM', () => void stop())
process.once('SIGINT', () => void stop())
let startupStage: StartupStage = 'host-start'
try {
  const host = await application
  startupStage = 'host-ready'
  await host.ready
  startupStage = 'bridge-service'
  const deadline = Date.now() + 30000
  let bridge
  while (!stopping && Date.now() < deadline) {
    bridge = host.ctx.get('agentsAnywhereRuntime')
    if (bridge) break
    await new Promise((done) => setTimeout(done, 100))
  }
  if (!bridge)
    throw Object.assign(new Error('Required RuntimeBridge unavailable'), {
      code: 'runtime_bridge_missing',
    })
  startupStage = 'bridge-start'
  if ((await bridge.restart()).state !== 'ready')
    throw Object.assign(new Error('Required RuntimeBridge unavailable'), {
      code: 'runtime_bridge_not_ready',
    })
  send({ type: 'host-ready' })
} catch (error) {
  send({
    type: 'host-error',
    code: 'harness-startup-failed',
    diagnostic: startupDiagnostic(startupStage, error),
  })
  await stop()
  process.exitCode = 1
}
