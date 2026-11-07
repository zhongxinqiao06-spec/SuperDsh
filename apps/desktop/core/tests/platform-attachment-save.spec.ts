import { expect, it, vi } from 'vitest'
import { savePlatformAttachment } from '../src/main/platform-attachment-save.ts'
import type { PlatformJson } from '../src/contracts/platform.ts'

const identity = { key: 'a'.repeat(64), generation: 1 }
const input = { identity, sessionId: 'session', attachmentId: 'artifact' }
it('saves only server-authorized bytes to the native dialog destination', async () => {
  const request = vi.fn(async (): Promise<PlatformJson> => ({
    name: '../成果.pptx',
    contentBase64: 'UEs=',
  }))
  const choose = vi.fn(async () => 'chosen.pptx')
  const write = vi.fn(async () => {})
  expect(
    await savePlatformAttachment(input, {
      identity: () => identity,
      request,
      choose,
      write,
    }),
  ).toEqual({ saved: true })
  expect(request).toHaveBeenCalledWith({
    ...input,
    operation: 'download-attachment',
  })
  expect(choose).toHaveBeenCalledWith('成果.pptx')
  expect(write).toHaveBeenCalledWith('chosen.pptx', Buffer.from('PK'))
})
it('does not save when the user cancels or switches accounts while choosing a path', async () => {
  for (const switched of [false, true]) {
    let current = identity
    const write = vi.fn(async () => {})
    const work = savePlatformAttachment(input, {
      identity: () => current,
      request: async () => ({ name: '成果.docx', contentBase64: 'UEs=' }),
      choose: async () => {
        if (switched) current = { ...identity, generation: 2 }
        return switched ? 'chosen.docx' : undefined
      },
      write,
    })
    if (switched) await expect(work).rejects.toThrow('账号已切换')
    else expect(await work).toEqual({ saved: false })
    expect(write).not.toHaveBeenCalled()
  }
})
