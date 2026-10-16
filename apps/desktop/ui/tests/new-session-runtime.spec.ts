import { expect, it } from 'vitest'
import { newSessionRuntime } from '../src/features/platform/new-session-runtime.ts'

const runtimes = [
  { runtimeId: 'stale-dsh', runtimeType: 'dsh', active: true },
  { runtimeId: 'managed-dsh', runtimeType: 'dsh', active: true },
]

it('uses the managed server Agent runtime even when older runtimes come first', () => {
  expect(newSessionRuntime(runtimes, 'managed-dsh')).toBe(runtimes[1])
  expect(newSessionRuntime(runtimes)).toBe(runtimes[0])
})

it('does not fall back when the managed runtime is missing, inactive or not ready', () => {
  expect(newSessionRuntime(runtimes, '')).toBeUndefined()
  expect(newSessionRuntime(runtimes, 'missing')).toBeUndefined()
  expect(
    newSessionRuntime([{ ...runtimes[1], active: false }], 'managed-dsh'),
  ).toBeUndefined()
})
