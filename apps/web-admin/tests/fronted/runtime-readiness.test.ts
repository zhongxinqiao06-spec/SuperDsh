import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, reactive, type EffectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useRuntimeReadiness } from '@/composables/workbench/use-runtime-readiness'
import { useRuntimeStore } from '@/store/modules/runtime-store'
import { ApiError } from '@/utils/errors'
import type { ServerAgent } from '@/api/workbench/runtime-api'

const mocks = vi.hoisted(() => ({
  generation: 1,
  listeners: new Set<() => void>(),
  get: vi.fn(),
  prepare: vi.fn(),
}))
vi.mock('@/store/session-controller', () => ({
  sessionController: {
    get generation() {
      return mocks.generation
    },
    subscribe: (callback: () => void) => {
      mocks.listeners.add(callback)
      return () => mocks.listeners.delete(callback)
    },
  },
}))
vi.mock('@/api/workbench/runtime-api', () => ({
  runtimeApi: { get: mocks.get, prepare: mocks.prepare },
}))

const agent = (status: ServerAgent['status']): ServerAgent => ({
  status,
  connectorId: 'synthetic',
  projectId: 'synthetic-project',
  runtimeId: 'dsh',
  error: null,
})
let scope: EffectScope
beforeEach(() => {
  vi.useFakeTimers()
  mocks.generation = 1
  mocks.listeners.clear()
  mocks.get.mockReset()
  mocks.prepare.mockReset()
  scope = effectScope()
})
afterEach(() => {
  scope.stop()
  vi.useRealTimers()
})

function setup() {
  const runtime = reactive({
    agent: agent('starting') as ServerAgent | null,
    error: '',
    prepare: vi.fn<(force?: boolean) => Promise<void>>().mockResolvedValue(),
    refresh: vi
      .fn<(signal?: AbortSignal) => Promise<void>>()
      .mockResolvedValue(),
  })
  const ready = vi.fn<() => Promise<void>>().mockResolvedValue()
  const controller = new AbortController()
  const readiness = scope.run(() =>
    useRuntimeReadiness(runtime, ready, controller.signal),
  )!
  return { runtime, ready, readiness, controller }
}

describe('服务端 Agent 准备状态恢复', () => {
  it('一次状态查询中断后继续只读轮询，就绪后加载目录且不重复启动', async () => {
    const { runtime, ready, readiness } = setup()
    runtime.refresh
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new ApiError('合成中断', 503))
      .mockImplementationOnce(async () => {
        runtime.agent = agent('running')
      })
    await readiness.prepare()
    await vi.advanceTimersByTimeAsync(1200)
    expect(runtime.error).toContain('重新同步')
    await vi.advanceTimersByTimeAsync(1200)
    expect(runtime.agent?.status).toBe('running')
    expect(runtime.error).toBe('')
    expect(ready).toHaveBeenCalledTimes(1)
    expect(runtime.prepare).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('就绪后的目录读取失败也能恢复，不再次创建运行实例', async () => {
    const { runtime, ready, readiness } = setup()
    runtime.agent = agent('running')
    ready.mockRejectedValueOnce(new ApiError('目录暂不可用', 502))
    await readiness.prepare()
    await vi.advanceTimersByTimeAsync(1200)
    expect(ready).toHaveBeenCalledTimes(2)
    expect(runtime.error).toBe('')
    expect(runtime.prepare).toHaveBeenCalledTimes(1)
  })

  it('持续失败有限重试后显示状态待确认，显式刷新可以恢复', async () => {
    const { runtime, ready, readiness } = setup()
    runtime.refresh.mockRejectedValue(
      new ApiError('网络断开', 0, 'network_unavailable'),
    )
    await readiness.prepare()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(runtime.refresh).toHaveBeenCalledTimes(4)
    expect(readiness.stalled.value).toBe(true)
    expect(runtime.agent?.status).toBe('starting')
    expect(runtime.error).toContain('刷新状态')
    expect(ready).not.toHaveBeenCalled()
    runtime.refresh.mockImplementation(async () => {
      runtime.agent = agent('running')
    })
    await readiness.prepare(true)
    expect(readiness.stalled.value).toBe(false)
    expect(runtime.error).toBe('')
    expect(ready).toHaveBeenCalledTimes(1)
  })

  it('权限拒绝不自动重试', async () => {
    const { runtime, readiness } = setup()
    runtime.refresh.mockRejectedValue(new ApiError('权限已撤销', 403))
    await readiness.prepare()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(runtime.refresh).toHaveBeenCalledTimes(1)
    expect(readiness.stalled.value).toBe(true)
  })

  it('准备超过期限停止轮询，不把服务端状态伪造为失败', async () => {
    const { runtime, readiness } = setup()
    await readiness.prepare()
    vi.setSystemTime(Date.now() + 180_000)
    await vi.advanceTimersByTimeAsync(1200)
    expect(readiness.stalled.value).toBe(true)
    expect(runtime.agent?.status).toBe('starting')
    expect(runtime.error).toContain('超过预期时间')
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['dispose', 'identity', 'abort'])(
    '%s 后停止轮询，不读取另一个生命周期的数据',
    async (action) => {
      const { runtime, readiness, controller } = setup()
      await readiness.prepare()
      if (action === 'dispose') scope.stop()
      else if (action === 'abort') controller.abort()
      else {
        mocks.generation++
        for (const listener of mocks.listeners) listener()
      }
      await vi.advanceTimersByTimeAsync(60_000)
      expect(runtime.refresh).toHaveBeenCalledTimes(1)
    },
  )

  it('较早状态请求迟到时不能把已就绪覆盖回准备中', async () => {
    setActivePinia(createPinia())
    const store = scope.run(() => useRuntimeStore())!
    let older!: (value: { agent: ServerAgent }) => void
    mocks.get
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            older = resolve
          }),
      )
      .mockResolvedValueOnce({ agent: agent('running') })
    const pending = store.refresh()
    await store.refresh()
    older({ agent: agent('starting') })
    await pending
    expect(store.agent?.status).toBe('running')
    store.$dispose()
  })
})
