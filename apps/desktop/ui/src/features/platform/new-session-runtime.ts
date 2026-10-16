import { string, type Row } from './platform-model.ts'

/** Managed targets must use the runtime registered by /server-agent. */
export function newSessionRuntime(
  runtimes: Row[],
  managedRuntimeId?: string,
): Row | undefined {
  if (managedRuntimeId === '') return undefined
  return runtimes.find(
    (row) =>
      row.runtimeType === 'dsh' &&
      row.active !== false &&
      (managedRuntimeId === undefined ||
        (string(row.runtimeId) || string(row.id)) === managedRuntimeId),
  )
}
