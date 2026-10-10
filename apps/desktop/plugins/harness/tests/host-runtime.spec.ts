import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { RunProfileOptions } from '@deepseek-ai/dsh/profile-boot'

const boot = vi.hoisted(() => ({ runProfile: vi.fn() }))
vi.mock('@deepseek-ai/dsh/profile-boot', () => boot)
import { startHarnessHost } from '../src/host-runtime.ts'

describe('shared full Host lifecycle', () => {
  it('uses the supplied installation exactly once and coalesces shutdown', async () => {
    const ctx = new Context()
    const refresh = vi.fn(async () => {})
    ctx.provide('superdshManagedModels', {
      refresh,
    } as unknown as Context['superdshManagedModels'])
    let finish!: () => void
    const dispose = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    boot.runProfile.mockResolvedValue({ ctx, shutdown: { shutdown: dispose } })
    const options = {
      profile: 'server-agent',
      resolvedProfile: { installAnchor: '/same-tree/package.json' },
    } as RunProfileOptions
    const host = await startHarnessHost(options)
    await host.ready
    expect(boot.runProfile).toHaveBeenCalledExactlyOnceWith(options)
    expect(host.ctx).toBe(ctx)
    await host.refreshModels()
    expect(refresh).toHaveBeenCalledTimes(1)
    const first = host.shutdown()
    expect(host.shutdown()).toBe(first)
    expect(host.status).toBe('stopping')
    await expect(host.refreshModels()).rejects.toThrow('stopping')
    finish()
    await first
    expect(host.status).toBe('stopped')
    expect(dispose).toHaveBeenCalledExactlyOnceWith(0)
  })
})
