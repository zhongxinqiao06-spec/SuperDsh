import type { PlatformBridge } from '../contracts/platform.ts'
export type * from '../contracts/platform.ts'
/** Only the trusted product renderer has this capability. */
export function platformBridge(): PlatformBridge | undefined {
  return (
    globalThis as typeof globalThis & { superdshPlatform?: PlatformBridge }
  ).superdshPlatform
}
