import { describe, expect, it, vi } from 'vitest'
import { resultApi } from '@/api/workbench/result-api'
import { request } from '@/utils/request'

vi.mock('@/utils/request', () => ({ request: vi.fn() }))

/** 附件仍通过会话授权端点读取 JSON，不能退回跨会话文件直链。 */
describe('附件下载协议', () => {
  it('对资源 ID 编码、传播取消信号并把旧契约正文转换成文件', async () => {
    vi.mocked(request).mockResolvedValueOnce({
      contentBase64: 'aGk=',
      contentType: 'text/plain',
      filename: 'synthetic.txt',
    })
    const signal = new AbortController().signal
    const result = await resultApi.attachment('session/a', 'file#b', signal)
    expect(request).toHaveBeenCalledWith(
      '/sessions/session%2Fa/attachments/file%23b',
      { signal, timeoutMs: 60000 },
    )
    expect(result.type).toBe('text/plain')
    expect(result.size).toBe(2)
  })
})
