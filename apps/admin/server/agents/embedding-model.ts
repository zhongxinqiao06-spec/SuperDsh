import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { EmbeddingProfile } from './knowledge-contracts.ts'

export const LOCAL_EMBEDDING: EmbeddingProfile = {
  id: 'bge-small-zh-v1.5-q8',
  kind: 'local',
  model: 'Xenova/bge-small-zh-v1.5',
  dimensions: 512,
  revision: '75c43b069aac4d136ba6bc1122f995fedcfd2781',
}

export const EMBEDDING_FILES = [
  [
    'config.json',
    'd4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f',
    716,
  ],
  [
    'tokenizer.json',
    '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26',
    439125,
  ],
  [
    'tokenizer_config.json',
    'e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a',
    367,
  ],
  [
    'special_tokens_map.json',
    'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3',
    125,
  ],
  [
    'vocab.txt',
    '45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c',
    109540,
  ],
  [
    'onnx/model_quantized.onnx',
    '15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc',
    24010842,
  ],
] as const

export async function verifyEmbeddingModel(
  directory: string,
  signal?: AbortSignal,
) {
  for (const [file, sha256, size] of EMBEDDING_FILES) {
    signal?.throwIfAborted()
    const path = join(directory, file)
    if (
      (await stat(path)).size !== size ||
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex') !== sha256
    )
      throw new Error(
        `Embedding 模型校验失败：${file}，请重新运行 server:knowledge:prepare`,
      )
  }
}

/** Explicit deployment/setup action. Runtime questions never download model files. */
export async function prepareEmbeddingModel(
  directory: string,
  signal?: AbortSignal,
) {
  for (const [file, sha256, size] of EMBEDDING_FILES) {
    signal?.throwIfAborted()
    const target = join(directory, file)
    try {
      const present = await readFile(target)
      if (
        present.length === size &&
        createHash('sha256').update(present).digest('hex') === sha256
      )
        continue
    } catch {
      /* Absent files are prepared below. */
    }
    const response = await fetch(
      `https://huggingface.co/${LOCAL_EMBEDDING.model}/resolve/${LOCAL_EMBEDDING.revision}/${file}`,
      {
        signal: AbortSignal.any([
          AbortSignal.timeout(180000),
          ...(signal ? [signal] : []),
        ]),
      },
    )
    if (!response.ok || !response.body)
      throw new Error(`Embedding 模型下载失败：${file} (${response.status})`)
    const parts: Uint8Array[] = []
    let length = 0
    for await (const part of response.body) {
      length += part.length
      if (length > size) {
        await response.body.cancel().catch(() => {})
        throw new Error(`Embedding 模型大小不符：${file}`)
      }
      parts.push(part)
    }
    const bytes = Buffer.concat(parts)
    if (
      bytes.length !== size ||
      createHash('sha256').update(bytes).digest('hex') !== sha256
    )
      throw new Error(`Embedding 模型校验失败：${file}`)
    await mkdir(dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.${randomUUID()}.partial`
    try {
      await writeFile(temporary, bytes, { flag: 'wx' })
      await rename(temporary, target)
    } finally {
      await rm(temporary, { force: true })
    }
  }
  await verifyEmbeddingModel(directory, signal)
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const directory = process.argv[2]
  if (!directory)
    throw new Error('Usage: node embedding-model.ts <model-directory>')
  await prepareEmbeddingModel(directory)
  console.log(`Embedding 模型已准备并校验：${directory}`)
}
