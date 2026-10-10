import { expect, it, vi } from 'vitest'
import { createShutdownCoordinator } from '../../src/application/shutdown.ts'

it('blocks repeated quit requests until ordered and parallel cleanup both finish', async () => {
  const importing = Promise.withResolvers<void>()
  const updates = Promise.withResolvers<void>()
  const calls: string[] = []
  const complete = vi.fn(async () => {})
  const failed = vi.fn()
  const quit = createShutdownCoordinator({
    ownsInstance: () => true,
    begin: () => {
      calls.push('begin')
    },
    parallelCleanup: () => updates.promise,
    cleanup: [
      async () => {
        calls.push('import')
        await importing.promise
      },
      async () => {
        calls.push('host')
      },
    ],
    complete,
    failed,
  })
  const event = { preventDefault: vi.fn() }
  quit(event)
  quit(event)
  expect(event.preventDefault).toHaveBeenCalledTimes(2)
  expect(calls).toEqual(['begin', 'import'])
  importing.resolve()
  await vi.waitFor(() => expect(calls).toEqual(['begin', 'import', 'host']))
  quit(event)
  expect(event.preventDefault).toHaveBeenCalledTimes(3)
  expect(complete).not.toHaveBeenCalled()
  updates.resolve()
  await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce())
  quit(event)
  expect(event.preventDefault).toHaveBeenCalledTimes(3)
  expect(failed).not.toHaveBeenCalled()
})

it('still drains the Host and waits for update cleanup when an earlier resource fails', async () => {
  const updates = Promise.withResolvers<void>()
  const host = vi.fn(async () => {})
  const complete = vi.fn(async () => {})
  const failed = vi.fn()
  const quit = createShutdownCoordinator({
    ownsInstance: () => true,
    begin() {},
    parallelCleanup: () => updates.promise,
    cleanup: [
      async () => {
        throw new Error('import close failed')
      },
      host,
    ],
    complete,
    failed,
  })
  const event = { preventDefault: vi.fn() }
  quit(event)
  await vi.waitFor(() => expect(host).toHaveBeenCalledOnce())
  expect(failed).not.toHaveBeenCalled()
  updates.reject(new Error('update close failed'))
  await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce())
  expect(failed.mock.calls[0]?.[0]).toBeInstanceOf(AggregateError)
  expect(complete).not.toHaveBeenCalled()
  quit(event)
  expect(event.preventDefault).toHaveBeenCalledTimes(2)
  expect(host).toHaveBeenCalledOnce()
})

it('does not intercept another application instance shutdown', () => {
  const begin = vi.fn()
  const quit = createShutdownCoordinator({
    ownsInstance: () => false,
    begin,
    parallelCleanup: async () => {},
    cleanup: [],
    complete: async () => {},
    failed() {},
  })
  const event = { preventDefault: vi.fn() }
  quit(event)
  expect(event.preventDefault).not.toHaveBeenCalled()
  expect(begin).not.toHaveBeenCalled()
})
