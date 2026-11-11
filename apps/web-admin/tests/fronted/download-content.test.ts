import { describe, expect, it } from 'vitest'
import { downloadContent } from '@/utils/files/download-content'

/** JSON 附件正文包含任意二进制字节，不能把 JSON 文本误作下载内容。 */
describe('会话附件下载适配', () => {
  it('保留非文本字节与媒体类型', async () => {
    const blob = downloadContent({
      contentBase64: 'AP+AQQ==',
      mediaType: 'application/octet-stream',
    })
    expect(blob.size).toBe(4)
    expect(blob.type).toBe('application/octet-stream')
    const bytes = await new Promise<number[]>((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = reject
      reader.onload = () =>
        resolve(Array.from(new Uint8Array(reader.result as ArrayBuffer)))
      reader.readAsArrayBuffer(blob)
    })
    expect(bytes).toEqual([0, 255, 128, 65])
  })
  it('接受空附件并拒绝损坏编码', () => {
    expect(
      downloadContent({ contentBase64: '', contentType: 'text/plain' }).size,
    ).toBe(0)
    expect(() => downloadContent({ contentBase64: '???' })).toThrow('编码无效')
  })
})
