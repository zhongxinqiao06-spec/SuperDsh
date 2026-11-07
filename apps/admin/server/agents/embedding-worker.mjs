import { parentPort, workerData } from 'node:worker_threads'

try {
  const { env, pipeline } = await import('@huggingface/transformers')
  env.allowRemoteModels = false
  env.allowLocalModels = true
  env.useBrowserCache = false
  const extractor = await pipeline('feature-extraction', workerData.directory, {
    local_files_only: true,
    dtype: 'q8',
    device: 'cpu',
    session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
  })
  try {
    const texts = workerData.texts.map((text) =>
      workerData.purpose === 'query'
        ? `为这个句子生成表示以用于检索相关文章：${text}`
        : text,
    )
    const output = await extractor(texts, {
      pooling: 'cls',
      normalize: true,
      truncation: true,
      max_length: 512,
    })
    parentPort.postMessage({ vectors: output.tolist() })
  } finally {
    await extractor.dispose()
  }
} catch {
  parentPort.postMessage({
    error: '本地 Embedding 执行失败，请检查模型文件及运行依赖后重试',
  })
}
