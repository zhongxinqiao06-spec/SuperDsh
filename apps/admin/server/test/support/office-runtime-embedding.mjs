import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  EMBEDDING_FILES,
  prepareEmbeddingModel,
  verifyEmbeddingModel,
} from '../../agents/embedding-model.ts'

/** Called only with the real Host test's disposable data directory. No live profile is modified. */
export async function prepareOfficeRuntimeEmbedding(dataDirectory) {
  const destination = join(dataDirectory, 'models', 'bge-small-zh-v1.5')
  const prepared = process.env.SUPERDSH_TEST_EMBEDDING_DIR
  if (!prepared) {
    await prepareEmbeddingModel(destination)
  } else {
    await verifyEmbeddingModel(prepared)
    for (const [filename] of EMBEDDING_FILES) {
      const target = join(destination, filename)
      await mkdir(dirname(target), { recursive: true })
      if (resolve(target) !== resolve(prepared, filename))
        await copyFile(join(prepared, filename), target)
    }
  }
  await verifyEmbeddingModel(destination)
  return destination
}
