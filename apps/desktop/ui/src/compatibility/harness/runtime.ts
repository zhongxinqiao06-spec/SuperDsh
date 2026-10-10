import { Context } from '@deepseek-ai/cordis'
import type { DshWindow } from './modules/manifest.ts'
import type { ClientModuleSystem } from './modules/system.ts'
import { bootClient, type EntryStateLabel } from './web/boot-client.ts'
import { getStaticModules } from './web/seed.ts'
import { applyIndexInjections } from './web/apply-injections.ts'
import { setClientMode, type ClientMode } from '../mode.ts'
import ownedModules from '../../owned-modules.json'

const admitted = new Set<string>([
  ...ownedModules,
  'dsh-community-market',
  'dshmarket',
  '@agents-anywhere/dsh-bridge-next',
])
interface DesktopBoot {
  ready(): Promise<{
    injections: Parameters<typeof applyIndexInjections>[0]
    streamBaseUrl: string
  }>
  failed(message: string): Promise<void>
}
type BootGlobal = DshWindow & {
  dshDesktopBoot?: DesktopBoot
  __DSH_BOOT_READY__?: PromiseWithResolvers<void>
  __DSH_TRANSPORT__?: {
    ownsHost: boolean
    streamBaseUrl?: string
    loadBundle?: (url: string) => Promise<void>
  }
}
export interface HarnessClientRuntime {
  readonly ctx: Context
  readonly modules: ClientModuleSystem
  dispose(): Promise<void>
}

/** Product controls activation. This function never mounts or owns a React root. */
export async function createHarnessClientRuntime(options: {
  mode: ClientMode
  onEntryState?: (name: string, state: EntryStateLabel) => void
}): Promise<HarnessClientRuntime> {
  setClientMode(options.mode)
  const win = globalThis as unknown as BootGlobal
  if (win.dshDesktopBoot) {
    const gate = win.__DSH_BOOT_READY__
    if (!gate) throw new Error('Desktop boot readiness is missing')
    try {
      const { injections, streamBaseUrl } = await win.dshDesktopBoot.ready()
      win.__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl }
      await applyIndexInjections(
        injections,
        (src) =>
          new Promise<void>((resolve, reject) => {
            const script = document.createElement('script')
            script.src = src
            script.onload = () => {
              resolve()
            }
            script.onerror = () => {
              reject(
                new Error(`Could not load the engine browser module: ${src}`),
              )
            }
            document.head.append(script)
          }),
      )
      gate.resolve()
    } catch (error) {
      gate.reject(error)
      throw error
    }
  }
  await win.__DSH_BOOT_READY__?.promise
  if (!win.__ModuleLoader__)
    throw new Error('The Harness browser module loader is unavailable')
  const modules = win.__ModuleLoader__.create({
    boot: win.__DSH_BOOT__,
    staticModules: getStaticModules(),
    ...(options.mode === 'product'
      ? { allowModule: (id: string) => admitted.has(id) }
      : {}),
    ...(win.__DSH_TRANSPORT__?.loadBundle
      ? { loadBundle: win.__DSH_TRANSPORT__.loadBundle }
      : {}),
  })
  const ctx = new Context()
  try {
    await Promise.all(
      modules.manifest.plugins
        .filter((row) => row.immediately)
        .map((row) => modules.prefetch(row.id).catch(() => {})),
    )
    await bootClient({
      ctx,
      modules,
      manifest: modules.manifest,
      ...(options.onEntryState ? { onEntryState: options.onEntryState } : {}),
    })
    return {
      ctx,
      modules,
      dispose: async () => {
        await ctx.fiber.dispose()
      },
    }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}
