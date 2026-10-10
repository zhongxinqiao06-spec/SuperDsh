export type ClientMode = 'product' | 'compatibility'
type ModeGlobal = typeof globalThis & { __SUPERDSH_CLIENT_MODE__?: ClientMode }
export function clientMode(): ClientMode | undefined {
  return (globalThis as ModeGlobal).__SUPERDSH_CLIENT_MODE__
}
export function setClientMode(mode: ClientMode): void {
  if (clientMode() !== undefined && clientMode() !== mode)
    throw new Error('A document cannot change its UI ownership mode')
  if (clientMode() === undefined)
    Object.defineProperty(globalThis, '__SUPERDSH_CLIENT_MODE__', {
      value: mode,
      writable: false,
      configurable: false,
    })
}
