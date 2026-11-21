import { describe, expect, it, vi } from 'vitest'
import { requestSignal } from '@/utils/request-timeout'

describe('前端 HTTP 等待时限', () => {
  it('默认两分钟，长任务可以延长至五分钟', () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    requestSignal()
    requestSignal(undefined, 250_000)
    requestSignal(undefined, 600_000)
    expect(timeout.mock.calls).toEqual([[120_000], [250_000], [300_000]])
  })

  it('离开页面后立即取消请求', () => {
    const controller = new AbortController()
    const signal = requestSignal(controller.signal)
    controller.abort()
    expect(signal.aborted).toBe(true)
  })
})
