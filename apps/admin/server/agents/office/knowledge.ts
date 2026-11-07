import { Worker } from 'node:worker_threads'
import { OfficeInputError, type OfficeInputFile } from './types.ts'
import type { KnowledgeSegment } from '../knowledge-contracts.ts'
import { validateInput } from './validation.ts'

export interface ExtractedKnowledge {
  filename: string
  text: string
  segments: KnowledgeSegment[]
}

export async function extractKnowledgeText(
  file: OfficeInputFile,
  signal?: AbortSignal,
): Promise<ExtractedKnowledge> {
  validateInput(file, ['.txt', '.md', '.csv', '.xlsx', '.docx', '.pdf'])
  signal?.throwIfAborted()
  const worker = new Worker(new URL('./knowledge-worker.ts', import.meta.url), {
    execArgv: [],
    workerData: { filename: file.filename, content: file.content },
    resourceLimits: { maxOldGenerationSizeMb: 256 },
  })
  return new Promise((resolve, reject) => {
    let done = false
    const finish = (error?: Error, value?: ExtractedKnowledge) => {
      if (done) return
      done = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', cancel)
      void worker.terminate()
      if (error) reject(error)
      else resolve(value!)
    }
    const cancel = () =>
      finish(
        signal?.reason instanceof Error
          ? signal.reason
          : new DOMException('知识解析已取消', 'AbortError'),
      )
    const timeout = setTimeout(
      () =>
        finish(new OfficeInputError('知识解析超过 30 秒，请拆分资料后重试')),
      30000,
    )
    signal?.addEventListener('abort', cancel, { once: true })
    worker.once(
      'message',
      (message: { value?: ExtractedKnowledge; error?: string }) =>
        finish(
          message.error ? new OfficeInputError(message.error) : undefined,
          message.value,
        ),
    )
    worker.once('error', () =>
      finish(
        new OfficeInputError('知识解析进程失败，请检查格式或拆分资料后重试'),
      ),
    )
    worker.once('exit', (code) => {
      if (!done) finish(new OfficeInputError(`知识解析进程提前退出（${code}）`))
    })
    if (signal?.aborted) cancel()
  })
}
