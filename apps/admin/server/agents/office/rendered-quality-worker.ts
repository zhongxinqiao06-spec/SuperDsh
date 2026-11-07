import { parentPort, workerData } from 'node:worker_threads'
import { checkRenderedDocument } from './rendered-quality.ts'
void checkRenderedDocument(
  { filename: workerData.filename, content: Buffer.from(workerData.content) },
  Buffer.from(workerData.pdf),
  workerData.missingFonts,
).then(
  (value) => parentPort!.postMessage({ value }),
  (error) =>
    parentPort!.postMessage({
      error: error instanceof Error ? error.message : '渲染结果检查失败',
    }),
)
