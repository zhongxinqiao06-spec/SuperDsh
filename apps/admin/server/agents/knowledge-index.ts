import { createHash } from 'node:crypto'
import { ApiError, text } from '../http/api-router.ts'
import type { Row } from '../infrastructure/database.ts'

export type KnowledgeSource = {
  assetId: string
  filename: string
  paragraph: number
  sha256: string
  content: string
}

/** Versioned local sparse encoding: English words and Chinese bigrams, no external key. */
export function sparseKnowledgeVector(value: string) {
  const words =
    value
      .normalize('NFKC')
      .toLowerCase()
      .match(/[a-z0-9]+|[\p{Script=Han}]+/gu) ?? []
  const weights = new Map<number, number>()
  const add = (term: string) => {
    const index = createHash('sha256').update(term).digest().readUInt32LE(0)
    weights.set(index, (weights.get(index) ?? 0) + 1)
  }
  for (const word of words) {
    if (/\p{Script=Han}/u.test(word)) {
      if (word.length === 1) add(word)
      for (let index = 0; index < word.length - 1; index++)
        add(word.slice(index, index + 2))
    } else add(word)
  }
  const entries = [...weights]
    .sort((a, b) => a[0] - b[0])
    .map(([index, count]) => [index!, 1 + Math.log(count!)])
  const norm =
    Math.sqrt(entries.reduce((sum, entry) => sum + entry[1]! ** 2, 0)) || 1
  return {
    indices: entries.map((entry) => entry[0]!),
    values: entries.map((entry) => entry[1]! / norm),
  }
}

export function knowledgeChunks(row: Row): KnowledgeSource[] {
  const content = text(row.extracted_text).slice(0, 100000)
  const chunks: KnowledgeSource[] = []
  for (let offset = 0; offset < content.length; offset += 800) {
    const part = content.slice(offset, offset + 900).trim()
    if (part && sparseKnowledgeVector(part).indices.length)
      chunks.push({
        assetId: text(row.id),
        filename: text(row.name),
        sha256: text(row.sha256),
        paragraph: chunks.length + 1,
        content: part,
      })
  }
  return chunks
}

const collection = 'superdsh_knowledge_sparse_v1'

export class QdrantKnowledgeIndex {
  private preparing?: Promise<void>
  private readonly origin: string
  private readonly apiKey?: string

  constructor(origin: string, apiKey?: string) {
    const url = new URL(origin)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        'SUPERDSH_QDRANT_URL must be an HTTP(S) address without credentials or query',
      )
    this.origin = origin.replace(/\/+$/, '')
    this.apiKey = apiKey
  }

  private async request(
    path: string,
    body?: unknown,
    method = body === undefined ? 'GET' : 'POST',
    signal?: AbortSignal,
    allowed: number[] = [],
  ): Promise<Row> {
    try {
      const response = await fetch(`${this.origin}${path}`, {
        method,
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { 'api-key': this.apiKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([
          AbortSignal.timeout(15000),
          ...(signal ? [signal] : []),
        ]),
      })
      if (allowed.includes(response.status))
        return { httpStatus: response.status }
      if (!response.ok) throw new Error('Knowledge index request failed')
      return (await response.json()) as Row
    } catch {
      signal?.throwIfAborted()
      this.preparing = undefined
      throw new ApiError(
        503,
        '知识库 Qdrant 暂不可用，请运行 server:deps:up 并重试索引。资料原文已保留。',
      )
    }
  }

  async status() {
    try {
      await this.request('/collections')
      return {
        engine: 'qdrant' as const,
        ready: true,
        message: 'Qdrant 已连接 · 中英文稀疏检索 · 无需额外模型 Key',
      }
    } catch {
      return {
        engine: 'qdrant' as const,
        ready: false,
        message:
          'Qdrant 未连接；请运行 server:deps:up。管理和上传仍可使用，检索需索引服务就绪。',
      }
    }
  }

  private async prepare(signal?: AbortSignal) {
    signal?.throwIfAborted()
    if (!this.preparing) {
      this.preparing = (async () => {
        const result = await this.request(
          `/collections/${collection}`,
          undefined,
          'GET',
          undefined,
          [404],
        )
        if (result.httpStatus === 404)
          await this.request(
            `/collections/${collection}`,
            { vectors: {}, sparse_vectors: { text: {} } },
            'PUT',
            undefined,
            [409],
          )
        for (const field of ['ownerId', 'assetId'])
          await this.request(
            `/collections/${collection}/index?wait=true`,
            { field_name: field, field_schema: 'keyword' },
            'PUT',
            undefined,
          )
      })()
      this.preparing.catch(() => {
        this.preparing = undefined
      })
    }
    if (!signal) return this.preparing
    // One user's cancellation must not abort shared collection initialization.
    let cancel: (() => void) | undefined
    try {
      await Promise.race([
        this.preparing,
        new Promise<never>((_resolve, reject) => {
          cancel = () => reject(signal.reason)
          signal.addEventListener('abort', cancel, { once: true })
        }),
      ])
    } finally {
      if (cancel) signal.removeEventListener('abort', cancel)
    }
  }

  async index(owner: string, rows: Row[], signal?: AbortSignal, force = false) {
    await this.prepare(signal)
    let chunks = 0
    for (const row of rows) {
      signal?.throwIfAborted()
      const parts = knowledgeChunks(row)
      const filter = {
        must: [
          { key: 'ownerId', match: { value: owner } },
          { key: 'assetId', match: { value: text(row.id) } },
          { key: 'sha256', match: { value: text(row.sha256) } },
        ],
      }
      const result = await this.request(
        `/collections/${collection}/points/count`,
        { filter, exact: true },
        'POST',
        signal,
      )
      chunks += parts.length
      if (!force && (result.result as Row)?.count === parts.length) continue
      for (let offset = 0; offset < parts.length; offset += 64) {
        const points = parts.slice(offset, offset + 64).map((part) => {
          const hash = createHash('sha256')
            .update(`${owner}:${part.assetId}:${part.sha256}:${part.paragraph}`)
            .digest('hex')
            .slice(0, 32)
          const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`
          return {
            id,
            vector: { text: sparseKnowledgeVector(part.content) },
            payload: { ...part, ownerId: owner },
          }
        })
        await this.request(
          `/collections/${collection}/points?wait=true`,
          { points },
          'PUT',
          signal,
        )
      }
    }
    return { indexedAssets: rows.length, chunks }
  }

  async search(
    owner: string,
    rows: Row[],
    query: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<KnowledgeSource[]> {
    signal.throwIfAborted()
    if (!rows.length) return []
    const vector = sparseKnowledgeVector(query.slice(0, 200))
    if (!vector.indices.length) return []
    await this.index(owner, rows, signal)
    const result = await this.request(
      `/collections/${collection}/points/query`,
      {
        query: vector,
        using: 'text',
        filter: {
          must: [
            { key: 'ownerId', match: { value: owner } },
            { key: 'assetId', match: { any: rows.map((row) => text(row.id)) } },
          ],
        },
        limit: Math.max(1, Math.min(limit, 8)),
        with_payload: true,
        with_vector: false,
        score_threshold: 0.000001,
      },
      'POST',
      signal,
    )
    const points =
      (result.result as { points?: { payload?: Row }[] })?.points ?? []
    // Reconstruct from PostgreSQL-authorized originals. Index payloads never grant access.
    const originals = new Map(
      rows.flatMap((row) =>
        knowledgeChunks(row).map(
          (part) =>
            [`${part.assetId}:${part.sha256}:${part.paragraph}`, part] as const,
        ),
      ),
    )
    return points.flatMap(({ payload }) => {
      if (payload?.ownerId !== owner) return []
      const part = originals.get(
        `${text(payload.assetId)}:${text(payload.sha256)}:${Number(payload.paragraph)}`,
      )
      return part ? [part] : []
    })
  }
}
