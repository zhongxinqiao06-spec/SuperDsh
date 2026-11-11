import { describe, expect, it, vi } from 'vitest'
import { SessionController } from '@/store/session-controller'
import type { AuthResponse } from '@/types/auth/auth'

function auth(userId: string, accessToken = `token-${userId}`): AuthResponse {
  return {
    userId,
    accessToken,
    username: userId,
    displayName: userId,
    email: null,
    role: 'member',
    roles: ['member'],
    permissions: [],
    authzVersion: 0,
    tokenType: 'bearer',
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('认证刷新与账号代际', () => {
  it('并发刷新只发一个请求，并保持同账号代际', async () => {
    const pending = deferred<Response>()
    const fetcher = vi.fn<typeof fetch>().mockReturnValue(pending.promise)
    const controller = new SessionController(fetcher)
    controller.accept(auth('a'))
    const generation = controller.generation
    const first = controller.refresh(),
      second = controller.refresh()
    expect(first).toBe(second)
    pending.resolve(Response.json(auth('a', 'rotated')))
    await first
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(controller.current?.accessToken).toBe('rotated')
    expect(controller.generation).toBe(generation)
  })

  it('登出先封锁身份，等待在途刷新后撤销Cookie，迟到响应不能复活账号', async () => {
    const pending = deferred<Response>()
    const calls: string[] = []
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      calls.push(String(input))
      return String(input).endsWith('/refresh')
        ? pending.promise
        : Promise.resolve(new Response(null, { status: 204 }))
    })
    const controller = new SessionController(fetcher)
    controller.accept(auth('a'))
    const refreshing = controller.refresh()
    const signingOut = controller.signOut()
    expect(controller.current).toBeNull()
    expect(calls).toEqual(['/api/auth/refresh'])
    pending.resolve(Response.json(auth('a', 'late')))
    await Promise.all([refreshing, signingOut])
    expect(calls).toEqual(['/api/auth/refresh', '/api/auth/logout'])
    expect(controller.current).toBeNull()
    expect(await controller.refresh()).toBeNull()
  })

  it('旧账号刷新不能覆盖后登录的新账号', async () => {
    const pending = deferred<Response>()
    const controller = new SessionController(
      vi.fn<typeof fetch>().mockReturnValue(pending.promise),
    )
    controller.accept(auth('a'))
    const refreshing = controller.refresh()
    controller.accept(auth('b'))
    pending.resolve(Response.json(auth('a')))
    await refreshing
    expect(controller.current?.userId).toBe('b')
  })

  it('网络登出失败后刷新页面仍不自动恢复旧Cookie身份', async () => {
    const controller = new SessionController(
      vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')),
    )
    controller.accept(auth('a'))
    await expect(controller.signOut()).rejects.toThrow('offline')
    const fetcher = vi.fn<typeof fetch>()
    const nextDocument = new SessionController(fetcher)
    expect(await nextDocument.refresh()).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })
})
