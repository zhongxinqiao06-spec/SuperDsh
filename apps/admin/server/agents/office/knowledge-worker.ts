import { parentPort, workerData } from 'node:worker_threads'
import { parseKnowledgeFile } from './knowledge-parser.ts'
import { OfficeInputError } from './types.ts'

try {
  const value = await parseKnowledgeFile({
    filename: String(workerData.filename),
    content: Buffer.from(workerData.content),
  })
  parentPort?.postMessage({ value })
} catch (error) {
  parentPort?.postMessage({
    error:
      error instanceof OfficeInputError
        ? error.message
        : '无法解析知识文件，请确认格式和文件完整性',
  })
}
