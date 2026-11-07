import { createHash } from 'node:crypto'

/** Synthetic deterministic vectors for API/ownership tests. Not a semantic model acceptance claim. */
export const syntheticKnowledgeEmbedding = {
  profile: {
    id: 'synthetic-test',
    kind: 'local',
    model: 'synthetic-test',
    revision: 'v1',
    dimensions: 16,
  },
  async ready(signal) {
    signal?.throwIfAborted()
  },
  async embed(texts, _purpose, signal) {
    signal?.throwIfAborted()
    return texts.map((text) => {
      const bytes = createHash('sha256').update(text).digest()
      const values = Array.from(
        { length: 16 },
        (_, i) => (bytes[i] - 127.5) / 127.5,
      )
      const norm = Math.sqrt(
        values.reduce((sum, value) => sum + value * value, 0),
      )
      return values.map((value) => value / norm)
    })
  },
}
