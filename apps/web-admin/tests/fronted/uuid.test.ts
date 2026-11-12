import { expect, it, vi } from 'vitest'
import { createUuid } from '@/utils/uuid'

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
  } finally {
    vi.unstubAllGlobals()
  }
})
