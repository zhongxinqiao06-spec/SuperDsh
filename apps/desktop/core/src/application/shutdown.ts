/** Product shutdown coordination; no Electron or renderer dependency. */
interface ShutdownOptions {
  ownsInstance(): boolean
  begin(): void
  /** Disposal outside the ordered runtime chain, such as the update download. */
  parallelCleanup(): Promise<void>
  /** Stop watchers, imports, repair commands and the Host in that order. */
  cleanup: readonly (() => Promise<void>)[]
  complete(): Promise<void>
  failed(error: unknown): void
}

export function createShutdownCoordinator(
  options: ShutdownOptions,
): (event: { preventDefault(): void }) => void {
  let closing = false
  let allowExit = false
  const dispose = async (): Promise<void> => {
    const ordered = async (): Promise<void> => {
      const errors: unknown[] = []
      for (const close of options.cleanup) {
        try {
          await close()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length)
        throw new AggregateError(errors, 'Runtime shutdown cleanup failed')
    }
    const results = await Promise.allSettled([
      Promise.resolve().then(options.parallelCleanup),
      ordered(),
    ])
    const failures = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason)
    if (failures.length)
      throw new AggregateError(failures, 'Desktop shutdown cleanup failed')
  }
  return (event) => {
    if (!options.ownsInstance() || allowExit) return
    event.preventDefault()
    if (closing) return
    closing = true
    options.begin()
    void dispose()
      .then(async () => {
        allowExit = true
        await options.complete()
      })
      .catch(options.failed)
  }
}
