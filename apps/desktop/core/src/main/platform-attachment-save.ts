import { writeFile } from 'node:fs/promises'
import type {
  PlatformIdentitySnapshot,
  PlatformJson,
  PlatformRequest,
} from '../contracts/platform.ts'

/** Authorized bytes stay in Core; only a native dialog chooses the destination. */
export async function savePlatformAttachment(
  input: {
    identity: PlatformIdentitySnapshot
    sessionId: string
    attachmentId: string
  },
  services: {
    identity(): PlatformIdentitySnapshot | null
    request(request: PlatformRequest): Promise<PlatformJson>
    choose(name: string): Promise<string | undefined>
    write?: typeof writeFile
  },
): Promise<{ saved: boolean }> {
  const check = () => {
    const current = services.identity()
    if (
      !input?.identity ||
      !current ||
      current.key !== input.identity.key ||
      current.generation !== input.identity.generation
    )
      throw new Error('平台账号已切换，文件保存已取消')
  }
  check()
  const value = await services.request({
    identity: input.identity,
    operation: 'download-attachment',
    sessionId: input.sessionId,
    attachmentId: input.attachmentId,
  })
  check()
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.contentBase64 !== 'string'
  )
    throw new Error('附件响应格式无效')
  const name =
    typeof value.name === 'string'
      ? value.name
          .split(/[\\/]/)
          .at(-1)!
          .replace(/[<>:"|?*\x00-\x1f]/g, '_')
      : '附件'
  const destination = await services.choose(name || '附件')
  check()
  if (!destination) return { saved: false }
  await (services.write ?? writeFile)(
    destination,
    Buffer.from(value.contentBase64, 'base64'),
  )
  return { saved: true }
}
