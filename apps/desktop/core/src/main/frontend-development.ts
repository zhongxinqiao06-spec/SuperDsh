/** Restart the desktop-managed backend only after a development frontend build commits its manifest. */
import { statSync, watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export interface FrontendDevelopmentOptions {
  manifestPath: string
  /** Return false while the runtime is busy; the same manifest remains pending without another file change. */
  refresh: (signal: AbortSignal) => Promise<void | boolean>
  onError: (error: unknown) => void
  environment?: NodeJS.ProcessEnv
  debounceMs?: number
}

export interface FrontendDevelopment {
  /** Cancel queued work and wait for the currently running refresh, if any. */
  dispose(): Promise<void>
}

export function startFrontendDevelopment({
  manifestPath,
  refresh,
  onError,
  environment = process.env,
  debounceMs = 150,
}: FrontendDevelopmentOptions): FrontendDevelopment {
  if (environment.SUPERDSH_WATCH !== '1') return { dispose: async () => {} }
  const manifestName = basename(manifestPath)
  let disposed = false
  let watcher: FSWatcher | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<void> | undefined
  let disposal: Promise<void> | undefined
  let pending = false
  const cancellation = new AbortController()
  const generation = (): string => {
    const stat = statSync(manifestPath, { bigint: true })
    if (!stat.isFile())
      throw new Error('The frontend artifact manifest is not a file')
    return `${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`
  }
  let current: string | undefined
  try {
    current = generation()
  } catch (error) {
    onError(error)
  }

  const drain = (): void => {
    if (disposed || running !== undefined) return
    running = (async () => {
      while (pending && !disposed) {
        pending = false
        try {
          const next = generation()
          if (next === current) continue
          const applied = await refresh(cancellation.signal)
          if (applied === false && !disposed) {
            pending = true
            await delay(Math.max(10, debounceMs), undefined, {
              signal: cancellation.signal,
            })
          } else current = next
        } catch (error) {
          if (!disposed) onError(error)
        }
      }
    })().finally(() => {
      running = undefined
    })
  }
  const changed = (_event: string, file: string | Buffer | null): void => {
    if (disposed || (file !== null && file.toString() !== manifestName)) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      pending = true
      drain()
    }, debounceMs)
  }
  try {
    // Watching the directory survives the writer's atomic rename over the manifest.
    watcher = watch(dirname(manifestPath), changed)
    watcher.on('error', (error) => {
      if (!disposed) onError(error)
    })
    // A build can finish between reading the baseline and installing the watch.
    if (generation() !== current) changed('rename', manifestName)
  } catch (error) {
    onError(error)
  }

  return {
    dispose: () =>
      (disposal ??= (async () => {
        disposed = true
        pending = false
        cancellation.abort()
        clearTimeout(timer)
        watcher?.close()
        await running
      })()),
  }
}
