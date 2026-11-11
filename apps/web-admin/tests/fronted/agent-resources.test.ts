import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ generation: 1, initialize: vi.fn() }))
vi.mock('@/api/agents/agents-api', () => ({
  agentsApi: { initialize: state.initialize },
}))
vi.mock('@/store/session-controller', () => ({ sessionController: state }))
beforeEach(() => {
  vi.resetModules()
  state.generation = 1
  state.initialize.mockReset().mockResolvedValue(undefined)
})

it('同登录并行资源列表共享准备，换号后重新准备', async () => {
  const { loadPreparedAgentResources: load } =
    await import('@/store/modules/agent-resources')
  const signal = new AbortController().signal
  expect(
    await Promise.all([
      load(signal, async () => 'agents'),
      load(signal, async () => 'skills'),
    ]),
  ).toEqual(['agents', 'skills'])
  expect(state.initialize).toHaveBeenCalledTimes(1)
  state.generation++
  await load(signal, async () => 'other-user')
  expect(state.initialize).toHaveBeenCalledTimes(2)
})

it('准备失败可重试，但原读取不能抢先执行', async () => {
  const { loadPreparedAgentResources: load } =
    await import('@/store/modules/agent-resources')
  const read = vi.fn(async () => 'ready'),
    signal = new AbortController().signal
  state.initialize.mockRejectedValueOnce(new Error('dependency unavailable'))
  await expect(load(signal, read)).rejects.toThrow('dependency unavailable')
  expect(read).not.toHaveBeenCalled()
  await expect(load(signal, read)).resolves.toBe('ready')
})

it('取消或换号阻止准备后的业务读取，不污染后续请求', async () => {
  const { loadPreparedAgentResources: load } =
    await import('@/store/modules/agent-resources')
  let complete!: () => void
  state.initialize.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      complete = resolve
    }),
  )
  const read = vi.fn(async () => 'old'),
    controller = new AbortController()
  const pending = load(controller.signal, read)
  controller.abort()
  complete()
  await expect(pending).rejects.toBeDefined()
  expect(read).not.toHaveBeenCalled()
  const waiting = load(new AbortController().signal, read)
  state.generation++
  await expect(waiting).rejects.toThrow('账号状态已变化')
  expect(read).not.toHaveBeenCalled()
})
