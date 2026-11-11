import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { repositoryRoot } from '../../scripts/paths.ts'

/** 使用冻结旧实现计算真实事件摘要，测试不复制一份期望算法。 */
const oracle = (await import(
  pathToFileURL(
    resolve(repositoryRoot, 'apps/admin/server/devices/connector-hub.ts'),
  ).href
)) as {
  eventEnvelope(
    session: string,
    sequence: number,
    type: string,
    payload: Record<string, unknown>,
  ): Record<string, unknown>
}
const input = createInterface({ input: process.stdin })
for await (const line of input) {
  const item = JSON.parse(line) as {
    session: string
    sequence: number
    type: string
    payload: Record<string, unknown>
  }
  process.stdout.write(
    JSON.stringify(
      oracle.eventEnvelope(
        item.session,
        item.sequence,
        item.type,
        item.payload,
      ),
    ) + '\n',
  )
}
