import type { Row } from '../infrastructure/database.ts'
import { createHash } from 'node:crypto'
import { text } from '../http/api-router.ts'
import { record } from './store.ts'

/** Keep provider details out of clients; translate a known terminal failure. */
export function runtimeFailure(reason: unknown): Row {
  const value = record(reason)
  const error = record(value.error ?? value.failure)
  if (
    /response incomplete: (length|max_output_tokens)/i.test(text(error.message))
  )
    return {
      code: 'MODEL_OUTPUT_LIMIT',
      message:
        '模型输出达到长度上限，本轮没有完成。请缩短本次修改范围，或调整所选模型的输出额度后再发送；系统不会自动重试。',
    }
  return {
    code: 'RUNTIME_EXECUTION_FAILED',
    message: '本轮执行失败，请检查模型或工具配置后重试。已生成的成果仍然保留。',
  }
}

/** Derived from a durable turn boundary, so reconnect rebuilds the same notice. */
export function runtimeFailureItems(items: Row[]): Row[] {
  return items.flatMap((item) => {
    const reason = record(record(item.content).reason)
    if (item.type !== 'turn.end' || reason.kind !== 'error') return [item]
    const failure = runtimeFailure(reason)
    const content = {
      kind: 'notice',
      text: failure.message,
      code: failure.code,
    }
    return [
      item,
      {
        ...item,
        id: `${text(item.id)}:failure`,
        type: 'system',
        status: 'failed',
        role: 'system',
        content,
        contentHash: `sha256:${createHash('sha256').update(JSON.stringify(content)).digest('hex')}`,
      },
    ]
  })
}
