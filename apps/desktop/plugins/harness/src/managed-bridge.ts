/** Product-managed identity uses only the pinned runtime bridge, never its OAuth/Connector owner. */
import { applyRuntime, Config } from '@agents-anywhere/dsh-bridge-next'
import type { Context } from '@deepseek-ai/cordis'
export { Config }
export const name = 'superdsh-managed-bridge'
export function apply(ctx: Context, config: Config): void {
  applyRuntime(ctx, config)
}
