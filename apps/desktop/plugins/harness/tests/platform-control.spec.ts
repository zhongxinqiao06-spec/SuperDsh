import type { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import {
  inspectPlatformTasks,
  stopPlatformTasks,
} from '../src/host/platform-control.ts'

it('inspects turn activity and between-turn maintenance without modifying work', async () => {
  const cancel = vi.fn()
  const agent = { status: 'idle', cancel, whenIdle: () => Promise.resolve() }
  const ctx = { get: () => ({ list: () => [agent] }) } as unknown as Context
  expect(await inspectPlatformTasks(ctx)).toBe(false)
  agent.status = 'running'
  expect(await inspectPlatformTasks(ctx)).toBe(true)
  agent.status = 'idle'
  agent.whenIdle = () => new Promise<void>(() => {})
  expect(await inspectPlatformTasks(ctx)).toBe(true)
  expect(cancel).not.toHaveBeenCalled()
})
it('cancels using the original Agent API and waits for cleanup, preserving the registry and Host', async () => {
  let settle!: () => void
  const idle = new Promise<void>((resolve) => {
    settle = resolve
  })
  const agent = {
    status: 'running',
    whenIdle: () => idle,
    cancel: vi.fn(() => {}),
  }
  const ctx = { get: () => ({ list: () => [agent] }) } as unknown as Context
  let completed = false
  const result = stopPlatformTasks(ctx).then((value) => {
    completed = true
    return value
  })
  await Promise.resolve()
  expect(agent.cancel).toHaveBeenCalledExactlyOnceWith({ kind: 'user' })
  expect(completed).toBe(false)
  agent.status = 'idle'
  settle()
  expect(await result).toBe(false)
})
it('refuses an account switch when task cleanup fails to reach idle', async () => {
  vi.useFakeTimers()
  const ctx = {
    get: () => ({
      list: () => [
        {
          status: 'running',
          cancel() {},
          whenIdle: () => new Promise<void>(() => {}),
        },
      ],
    }),
  } as unknown as Context
  try {
    const result = expect(stopPlatformTasks(ctx)).rejects.toThrow(
      '已保留当前账号',
    )
    await vi.advanceTimersByTimeAsync(15_000)
    await result
  } finally {
    vi.useRealTimers()
  }
})
