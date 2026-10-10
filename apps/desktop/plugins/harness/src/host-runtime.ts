/** Shared full-Host lifecycle; the composing product owns IPC and process supervision. */
import type { Context } from '@deepseek-ai/cordis'
import {
  runProfile,
  type RunProfileOptions,
} from '@deepseek-ai/dsh/profile-boot'
import { refreshPlatformModels } from './host/platform-control.ts'

export interface HarnessHost {
  readonly ctx: Context
  readonly ready: Promise<void>
  readonly status: 'ready' | 'stopping' | 'stopped'
  shutdown(code?: number): Promise<void>
  refreshModels(): Promise<void>
}

/** runProfile and its installAnchor must resolve through this package's dependency tree. */
export async function startHarnessHost(
  options: RunProfileOptions,
): Promise<HarnessHost> {
  const application = await runProfile(options)
  let status: HarnessHost['status'] = 'ready'
  let stopping: Promise<void> | undefined
  return {
    ctx: application.ctx,
    ready: Promise.resolve(),
    get status() {
      return status
    },
    shutdown(code = 0) {
      stopping ??= (async () => {
        status = 'stopping'
        try {
          await application.shutdown.shutdown(code)
        } finally {
          status = 'stopped'
        }
      })()
      return stopping
    },
    async refreshModels() {
      if (status !== 'ready') throw new Error('Harness Host is stopping')
      await refreshPlatformModels(application.ctx)
    },
  }
}
