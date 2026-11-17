import { expect, it, vi } from 'vitest'
import { createUuid } from '@/utils/uuid'
import { newShot } from '@/utils/studio/storyboard'

it('安全上下文优先使用原生 UUID，并保留 Web Crypto 方法的接收对象', () => {
  const id = '12345678-1234-4321-8123-123456789abc'
  const provider = {
    randomUUID: vi.fn(function (this: unknown) {
      expect(this).toBe(provider)
      return id
    }),
    getRandomValues: vi.fn(),
  }
  vi.stubGlobal('crypto', provider)
  expect(createUuid()).toBe(id)
  expect(provider.randomUUID).toHaveBeenCalledOnce()
  expect(provider.getRandomValues).not.toHaveBeenCalled()
})

it.each([
  [0x00, '00000000-0000-4000-8000-000000000000'],
  [0xff, 'ffffffff-ffff-4fff-bfff-ffffffffffff'],
])('HTTP 随机字节 %i 只改版本与变体位，其他随机位保留', (byte, id) => {
  const getRandomValues = vi.fn((bytes: Uint8Array) => {
    expect(bytes.byteLength).toBe(16)
    return bytes.fill(byte)
  })
  vi.stubGlobal('crypto', { getRandomValues })
  expect(createUuid()).toBe(id)
  expect(getRandomValues).toHaveBeenCalledOnce()
})

it.each([undefined, {}])(
  '缺少 Web Crypto 时明确报错，不降级为伪随机',
  (provider) => {
    vi.stubGlobal('crypto', provider)
    const random = vi.spyOn(Math, 'random')
    expect(createUuid).toThrow('当前浏览器缺少安全随机数能力')
    expect(random).not.toHaveBeenCalled()
  },
)

it('普通 HTTP 缺少 randomUUID 时仍可生成不同的标准 UUIDv4', () => {
  const getRandomValues = globalThis.crypto.getRandomValues.bind(
    globalThis.crypto,
  )
  vi.stubGlobal('crypto', { getRandomValues })
  try {
    const ids = Array.from({ length: 64 }, createUuid)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids)
      expect(id).toMatch(
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
      )
    // 覆盖实际白屏入口：创建分镜不再绕过公共方法调用安全上下文限定 API。
    expect(newShot().id).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    )
  } finally {
    vi.unstubAllGlobals()
  }
})
