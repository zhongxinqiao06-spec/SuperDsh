import { Worker } from 'node:worker_threads'
import { ApiError } from '../http/api-router.ts'
import type { Row } from '../infrastructure/database.ts'
import type { ResolvedOfficeSource } from './office-sources.ts'

/** CPU-heavy parsing and ZIP generation cannot block the platform event loop. */
export async function officeWork(
  operation: 'inspect' | 'prepare' | 'generate',
  tool: string,
  sources: ResolvedOfficeSource[],
  document: unknown,
  signal: AbortSignal,
): Promise<Row> {
  signal.throwIfAborted()
  const worker = new Worker(new URL('./office-worker.ts', import.meta.url), {
    workerData: { operation, tool, sources, document },
    resourceLimits: {
      maxOldGenerationSizeMb: 256,
      maxYoungGenerationSizeMb: 32,
    },
  })
  let timer: NodeJS.Timeout | undefined
  let abort: () => void = () => {}
  try {
    return await new Promise<Row>((resolve, reject) => {
      abort = () =>
        reject(
          signal.reason instanceof ApiError
            ? signal.reason
            : new ApiError(499, '办公任务已取消'),
        )
      signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(
        () =>
          reject(
            new ApiError(
              504,
              '办公文件处理超时，请减少输入数据或拆分任务后重试',
            ),
          ),
        85000,
      )
      worker.once('message', (message: { value?: Row; error?: string }) => {
        if (message.error) reject(new ApiError(422, message.error))
        else resolve(message.value ?? {})
      })
      worker.once('error', () =>
        reject(new ApiError(500, '办公文件处理进程异常，请重试或查看服务诊断')),
      )
      worker.once('exit', (code) => {
        if (code !== 0) reject(new ApiError(500, '办公文件处理进程提前退出'))
      })
      if (signal.aborted) abort()
    })
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    await worker.terminate()
  }
}
