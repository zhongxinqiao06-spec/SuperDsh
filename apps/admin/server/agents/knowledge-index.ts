import { createHash } from 'node:crypto'
import { ApiError, text } from '../http/api-router.ts'
import { json, type Row } from '../infrastructure/database.ts'
import type {
  KnowledgeDocumentStatus,
  KnowledgeEmbedding,
  KnowledgeLocation,
  KnowledgeSegment,
} from './knowledge-contracts.ts'

export type KnowledgeSource = {
  sourceId: string
  assetId: string
  filename: string
  paragraph: number
  sha256: string
  content: string
  location: KnowledgeLocation
}

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
    .map(([index, count]) => [index, 1 + Math.log(count)])
  const norm =
    Math.sqrt(entries.reduce((sum, entry) => sum + entry[1]! ** 2, 0)) || 1
  return {
    indices: entries.map((entry) => entry[0]!),
    values: entries.map((entry) => entry[1]! / norm),
  }
}

/** A stable source identifies an immutable authorized excerpt, never an index payload. */
export function knowledgeChunks(row: Row): KnowledgeSource[] {
  const stored = Array.isArray(row.source_segments_json)
    ? (row.source_segments_json as KnowledgeSegment[])
    : json<KnowledgeSegment[]>(row.source_segments_json, [])
  const segments: KnowledgeSegment[] =
    Array.isArray(stored) && stored.length
      ? stored
      : text(row.extracted_text)
          .slice(0, 100000)
          .split(/\r?\n/u)
          .map((value) => ({
            text: value,
            // Legacy extracted_text was flattened by the old parser. Its
            // newlines are not evidence of physical source lines or paragraphs.
            location: {},
          }))
  const chunks: KnowledgeSource[] = []
  for (const [segmentIndex, segment] of segments.entries()) {
    if (typeof segment.text !== 'string' || !segment.location) continue
    for (let offset = 0; offset < segment.text.length; offset += 800) {
      const content = segment.text.slice(offset, offset + 900).trim()
      if (!content || !sparseKnowledgeVector(content).indices.length) continue
      const location = {
        ...segment.location,
        ...(offset && Object.keys(segment.location).length ? { offset } : {}),
      }
      const sourceId = `src_${createHash('sha256')
        .update(
          `${text(row.id)}:${text(row.sha256)}:${segmentIndex}:${offset}:${content}`,
        )
        .digest('hex')
        .slice(0, 32)}`
      chunks.push({
        sourceId,
        assetId: text(row.id),
        filename: text(row.name),
        sha256: text(row.sha256),
        paragraph: segment.location.paragraph ?? 0,
        location,
        content,
      })
    }
  }
  return chunks
}

export function verifyKnowledgeQuote(
  rows: Row[],
  sourceId: string,
  quote?: string,
): KnowledgeSource {
  const source = rows
    .flatMap(knowledgeChunks)
    .find((part) => part.sourceId === sourceId)
  if (!source) throw new ApiError(404, '原文证据不存在或当前会话无权访问')
  if (
    quote !== undefined &&
    (!quote.trim() || quote.length > 900 || !source.content.includes(quote))
  )
    throw new ApiError(422, '引用摘录必须与授权原文逐字一致')
  return source
}

function partsHaveLocations(row: Row) {
  return knowledgeChunks(row).every(
    (source) => Object.keys(source.location).length > 0,
  )
}

export function embeddingGeneration(embedding: KnowledgeEmbedding) {
  const p = embedding.profile
  return createHash('sha256')
    .update(
      JSON.stringify([
        p.kind,
        p.model,
        p.revision,
        p.dimensions,
        p.baseUrl ?? '',
        'source-v2',
      ]),
    )
    .digest('hex')
    .slice(0, 20)
}

type Prepared = {
  embedding: KnowledgeEmbedding
  collection: string
  generation: string
}

export class QdrantKnowledgeIndex {
  private readonly preparing = new Map<string, Promise<void>>()
  private readonly states = new Map<string, KnowledgeDocumentStatus>()
  private readonly origin: string
  private readonly apiKey?: string
  private readonly embeddingProvider?:
    KnowledgeEmbedding | (() => KnowledgeEmbedding)

  constructor(
    origin: string,
    apiKey?: string,
    embedding?: KnowledgeEmbedding | (() => KnowledgeEmbedding),
  ) {
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
    this.embeddingProvider = embedding
  }

  private context(override?: KnowledgeEmbedding): Prepared {
    const embedding =
      override ??
      (typeof this.embeddingProvider === 'function'
        ? this.embeddingProvider()
        : this.embeddingProvider)
    if (!embedding)
      throw new ApiError(
        503,
        '知识库语义模型尚未配置，请在知识检索设置中准备本地模型或配置 Embedding 供应商',
      )
    const generation = embeddingGeneration(embedding)
    return {
      embedding,
      generation,
      collection: `superdsh_knowledge_hybrid_${generation}`,
    }
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
      throw new ApiError(
        503,
        '知识库 Qdrant 暂不可用，请运行 server:deps:up 并重试索引。资料原文已保留。',
      )
    }
  }

  async status() {
    try {
      await this.request('/collections')
      const context = this.context()
      await context.embedding.ready(AbortSignal.timeout(30000))
      return {
        engine: 'qdrant' as const,
        ready: true,
        generation: context.generation,
        embedding: context.embedding.profile,
        message: 'Qdrant 已连接 · 语义与关键词混合检索',
      }
    } catch (error) {
      return {
        engine: 'qdrant' as const,
        ready: false,
        message:
          error instanceof ApiError
            ? error.message
            : '知识检索服务尚未就绪；资料原文已保留',
      }
    }
  }

  private async prepare(context: Prepared, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const { collection, embedding } = context
    let preparing = this.preparing.get(collection)
    if (!preparing) {
      preparing = (async () => {
        await embedding.ready(AbortSignal.timeout(30000))
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
            {
              vectors: {
                semantic: {
                  size: embedding.profile.dimensions,
                  distance: 'Cosine',
                },
              },
              sparse_vectors: { text: {} },
            },
            'PUT',
            undefined,
            [409],
          )
        for (const field of ['ownerId', 'assetId', 'sha256'])
          await this.request(
            `/collections/${collection}/index?wait=true`,
            { field_name: field, field_schema: 'keyword' },
            'PUT',
          )
      })()
      this.preparing.set(collection, preparing)
      preparing.catch(() => this.preparing.delete(collection))
    }
    if (!signal) return preparing
    let cancel: (() => void) | undefined
    try {
      await Promise.race([
        preparing,
        new Promise<never>((_resolve, reject) => {
          cancel = () => reject(signal.reason)
          signal.addEventListener('abort', cancel, { once: true })
          if (signal.aborted) cancel()
        }),
      ])
    } finally {
      if (cancel) signal.removeEventListener('abort', cancel)
    }
  }

  private assetFilter(owner: string, row: Row) {
    return {
      must: [
        { key: 'ownerId', match: { value: owner } },
        { key: 'assetId', match: { value: text(row.id) } },
        { key: 'sha256', match: { value: text(row.sha256) } },
      ],
    }
  }

  async documentStatus(
    owner: string,
    rows: Row[],
    signal?: AbortSignal,
  ): Promise<KnowledgeDocumentStatus[]> {
    const context = this.context()
    await this.prepare(context, signal)
    const statuses: KnowledgeDocumentStatus[] = []
    for (const row of rows) {
      const key = `${owner}:${row.id}:${row.sha256}:${context.generation}`
      const chunks = knowledgeChunks(row).length
      const result = await this.request(
        `/collections/${context.collection}/points/count`,
        { filter: this.assetFilter(owner, row), exact: true },
        'POST',
        signal,
      )
      const previous = this.states.get(key)
      statuses.push({
        assetId: text(row.id),
        filename: text(row.name),
        sha256: text(row.sha256),
        generation: context.generation,
        chunks,
        state:
          previous?.state === 'failed'
            ? 'failed'
            : chunks && (result.result as Row)?.count === chunks
              ? 'ready'
              : previous?.state === 'indexing'
                ? 'indexing'
                : 'pending',
        ...(previous?.message
          ? { message: previous.message }
          : partsHaveLocations(row)
            ? {}
            : {
                message:
                  '旧资料未记录原文位置。点击重试索引，从保留的原文件重新解析；原文件和哈希保持不变。',
              }),
      })
    }
    return statuses
  }

  recordDocumentFailure(owner: string, row: Row, message: string) {
    const { generation } = this.context()
    this.states.set(`${owner}:${row.id}:${row.sha256}:${generation}`, {
      assetId: text(row.id),
      filename: text(row.name),
      sha256: text(row.sha256),
      generation,
      chunks: knowledgeChunks(row).length,
      state: 'failed',
      message,
    })
  }

  async index(
    owner: string,
    rows: Row[],
    signal?: AbortSignal,
    force = false,
    override?: KnowledgeEmbedding,
  ) {
    const context = this.context(override)
    return this.indexContext(context, owner, rows, signal, force)
  }

  private async indexContext(
    context: Prepared,
    owner: string,
    rows: Row[],
    signal?: AbortSignal,
    force = false,
  ) {
    await this.prepare(context, signal)
    let chunks = 0
    for (const row of rows) {
      signal?.throwIfAborted()
      const parts = knowledgeChunks(row)
      const key = `${owner}:${row.id}:${row.sha256}:${context.generation}`
      const state: KnowledgeDocumentStatus = {
        assetId: text(row.id),
        filename: text(row.name),
        sha256: text(row.sha256),
        generation: context.generation,
        chunks: parts.length,
        state: 'indexing',
      }
      this.states.set(key, state)
      // Bound status-only memory; authoritative completed state remains in Qdrant.
      if (this.states.size > 5000)
        this.states.delete(this.states.keys().next().value!)
      try {
        if (!parts.length)
          throw new ApiError(422, '知识资料没有可检索文字，请重新解析后重试')
        const result = await this.request(
          `/collections/${context.collection}/points/count`,
          { filter: this.assetFilter(owner, row), exact: true },
          'POST',
          signal,
        )
        chunks += parts.length
        if (force || (result.result as Row)?.count !== parts.length) {
          for (let offset = 0; offset < parts.length; offset += 16) {
            const batch = parts.slice(offset, offset + 16)
            const vectors = await context.embedding.embed(
              batch.map((part) => part.content),
              'document',
              signal,
            )
            const points = batch.map((part, i) => {
              const hash = createHash('sha256')
                .update(`${owner}:${part.sourceId}`)
                .digest('hex')
                .slice(0, 32)
              return {
                id: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`,
                vector: {
                  text: sparseKnowledgeVector(part.content),
                  semantic: vectors[i],
                },
                payload: { ...part, ownerId: owner },
              }
            })
            await this.request(
              `/collections/${context.collection}/points?wait=true`,
              { points },
              'PUT',
              signal,
            )
          }
        }
        state.state = 'ready'
      } catch (error) {
        state.state = signal?.aborted ? 'pending' : 'failed'
        state.message =
          error instanceof ApiError
            ? error.message
            : signal?.aborted
              ? '索引已取消，可重试'
              : '索引失败，请检查模型和 Qdrant 后重试'
        throw error
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
    const context = this.context()
    await this.indexContext(context, owner, rows, signal)
    const [semantic] = await context.embedding.embed(
      [query.slice(0, 200)],
      'query',
      signal,
    )
    const filter = {
      must: [
        { key: 'ownerId', match: { value: owner } },
        { key: 'assetId', match: { any: rows.map((row) => text(row.id)) } },
      ],
    }
    const result = await this.request(
      `/collections/${context.collection}/points/query`,
      {
        prefetch: [
          {
            query: vector,
            using: 'text',
            filter,
            limit: 32,
            score_threshold: 0.000001,
          },
          {
            query: semantic,
            using: 'semantic',
            filter,
            limit: 32,
            score_threshold: 0.46,
          },
        ],
        query: { fusion: 'rrf' },
        filter,
        limit: Math.max(1, Math.min(limit, 8)),
        with_payload: true,
        with_vector: false,
      },
      'POST',
      signal,
    )
    const points =
      (result.result as { points?: { payload?: Row }[] })?.points ?? []
    const originals = new Map(
      rows
        .flatMap(knowledgeChunks)
        .map((part) => [part.sourceId, part] as const),
    )
    const seen = new Set<string>()
    return points.flatMap(({ payload }) => {
      if (payload?.ownerId !== owner) return []
      const part = originals.get(text(payload.sourceId))
      if (
        !part ||
        seen.has(part.sourceId) ||
        part.assetId !== payload.assetId ||
        part.sha256 !== payload.sha256
      )
        return []
      seen.add(part.sourceId)
      return [part]
    })
  }
}
