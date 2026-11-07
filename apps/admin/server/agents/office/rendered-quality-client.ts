import { Worker } from 'node:worker_threads'
import { ApiError } from '../../http/api-router.ts'
import type { OfficeInputFile } from './types.ts'
import type { RenderedQuality } from './rendered-quality.ts'

export async function renderedQuality(
  file: OfficeInputFile,
  pdf: Buffer,
  missingFonts: string[],
  signal: AbortSignal,
): Promise<RenderedQuality> {
  signal.throwIfAborted()
  const worker = new Worker(
    new URL('./rendered-quality-worker.ts', import.meta.url),
    {
      workerData: {
        filename: file.filename,
        content: file.content,
        pdf,
        missingFonts,
      },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    },
  )
  let timer: NodeJS.Timeout | undefined
  let abort = () => {}
  try {
    return await new Promise<RenderedQuality>((resolve, reject) => {
      abort = () => reject(signal.reason ?? new ApiError(499, '文档检查已取消'))
      signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(
        () => reject(new ApiError(504, '最终文件检查超时')),
        30000,
      )
      worker.once(
        'message',
        (message: { value?: RenderedQuality; error?: string }) =>
          message.value
            ? resolve(message.value)
            : reject(new ApiError(422, message.error ?? '渲染检查失败')),
      )
      worker.once('error', () => reject(new ApiError(500, '渲染检查进程异常')))
      worker.once('exit', (code) => {
        if (code !== 0) reject(new ApiError(500, '渲染检查进程退出'))
      })
      if (signal.aborted) abort()
    })
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    await worker.terminate()
  }
}
