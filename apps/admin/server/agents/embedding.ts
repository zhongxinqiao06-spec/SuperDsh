import { Worker } from 'node:worker_threads'
import { ApiError } from '../http/api-router.ts'
import { providerRequest } from '../models/provider-http.ts'
import type {
  EmbeddingProfile,
  KnowledgeEmbedding,
} from './knowledge-contracts.ts'
import { LOCAL_EMBEDDING, verifyEmbeddingModel } from './embedding-model.ts'

export function validateVectors(
  value: unknown,
  count: number,
  dimensions: number,
): number[][] {
  if (!Array.isArray(value) || value.length !== count)
    throw new ApiError(502, 'Embedding 返回向量数量不符')
  return value.map((row) => {
    if (
      !Array.isArray(row) ||
      row.length !== dimensions ||
      row.some((n) => typeof n !== 'number' || !Number.isFinite(n))
    )
      throw new ApiError(502, 'Embedding 返回无效向量或维度不符')
    const norm = Math.sqrt(row.reduce((sum, n) => sum + n * n, 0))
    if (!Number.isFinite(norm) || norm <= 0)
      throw new ApiError(502, 'Embedding 返回空向量')
    return row.map((n) => n / norm)
  })
}

function validateTexts(texts: string[]) {
  if (
    !texts.length ||
    texts.length > 32 ||
    texts.some((text) => !text.trim() || text.length > 2000)
  )
    throw new ApiError(422, 'Embedding 每批支持 1–32 段，每段最多 2000 字符')
}

let activeWorkers = 0

/** Data-export authorization is distinct from the network/SSRF allowlist. */
export function requireTrustedEmbeddingOrigin(
  baseUrl: string,
  trustedOrigins: string,
) {
  let origin: string
  try {
    origin = new URL(baseUrl).origin
  } catch {
    throw new ApiError(422, 'Embedding 地址无效')
  }
  const trusted = new Set<string>()
  for (const value of trustedOrigins
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new ApiError(503, '部署侧 Embedding 信任列表无效，请联系部署维护者')
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new ApiError(
        503,
        '部署侧 Embedding 信任列表只能包含完整 origin，不能包含路径或凭据',
      )
    trusted.add(url.origin)
  }
  if (!trusted.has(origin))
    throw new ApiError(
      403,
      '外部 Embedding 地址未获资料外发许可。请由部署维护者在 SUPERDSH_KNOWLEDGE_EMBEDDING_TRUSTED_ORIGINS 明确配置可信 origin；网页不能修改此列表，内网访问白名单不能替代该许可。',
    )
}
export class LocalKnowledgeEmbedding implements KnowledgeEmbedding {
  readonly profile = { ...LOCAL_EMBEDDING }
  readonly directory: string
  constructor(directory: string) {
    this.directory = directory
  }
  async ready(signal?: AbortSignal) {
    try {
      await verifyEmbeddingModel(this.directory, signal)
    } catch {
      signal?.throwIfAborted()
      throw new ApiError(
        503,
        '本地语义模型尚未准备或校验失败，请运行 server:knowledge:prepare；资料原文已保留',
      )
    }
  }
  async embed(
    texts: string[],
    purpose: 'query' | 'document',
    signal?: AbortSignal,
  ) {
    validateTexts(texts)
    signal?.throwIfAborted()
    await this.ready(signal)
    if (activeWorkers >= 2)
      throw new ApiError(503, '语义索引正在处理其他资料，请稍后重试')
    const worker = new Worker(
      new URL('./embedding-worker.mjs', import.meta.url),
      {
        execArgv: [],
        workerData: { directory: this.directory, texts, purpose },
        resourceLimits: { maxOldGenerationSizeMb: 384 },
      },
    )
    activeWorkers++
    try {
      return await new Promise<number[][]>((resolve, reject) => {
        let done = false
        const finish = (error?: Error, vectors?: unknown) => {
          if (done) return
          done = true
          clearTimeout(timer)
          signal?.removeEventListener('abort', cancel)
          if (error) reject(error)
          else {
            try {
              resolve(
                validateVectors(vectors, texts.length, this.profile.dimensions),
              )
            } catch (failure) {
              reject(failure)
            }
          }
        }
        const cancel = () =>
          finish(
            signal?.reason instanceof Error
              ? signal.reason
              : new DOMException('Embedding 已取消', 'AbortError'),
          )
        const timer = setTimeout(
          () =>
            finish(new ApiError(504, 'Embedding 超过 60 秒，请缩小资料后重试')),
          60000,
        )
        signal?.addEventListener('abort', cancel, { once: true })
        worker.once(
          'message',
          (message: { vectors?: unknown; error?: string }) =>
            finish(
              message.error ? new ApiError(503, message.error) : undefined,
              message.vectors,
            ),
        )
        worker.once('error', () =>
          finish(new ApiError(503, 'Embedding 工作进程失败，请检查运行依赖')),
        )
        worker.once('exit', () => {
          if (!done) finish(new ApiError(503, 'Embedding 工作进程提前退出'))
        })
        if (signal?.aborted) cancel()
      })
    } finally {
      await worker.terminate()
      activeWorkers--
    }
  }
}

export class ExternalKnowledgeEmbedding implements KnowledgeEmbedding {
  readonly profile: EmbeddingProfile
  private readonly apiKey: string
  private readonly allowedOrigins: string
  private readonly trustedOrigins: string
  constructor(
    profile: EmbeddingProfile,
    apiKey: string,
    allowedOrigins = '',
    trustedOrigins = '',
  ) {
    this.profile = { ...profile }
    this.apiKey = apiKey
    this.allowedOrigins = allowedOrigins
    this.trustedOrigins = trustedOrigins
  }
  async ready(signal?: AbortSignal) {
    await this.embed(['语义索引连通性检查'], 'document', signal)
  }
  async embed(
    texts: string[],
    _purpose: 'query' | 'document',
    signal?: AbortSignal,
  ) {
    validateTexts(texts)
    requireTrustedEmbeddingOrigin(this.profile.baseUrl!, this.trustedOrigins)
    const bounded = AbortSignal.any([
      AbortSignal.timeout(30000),
      ...(signal ? [signal] : []),
    ])
    const response = await providerRequest({
      url: `${this.profile.baseUrl!.replace(/\/+$/, '')}/embeddings`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: Buffer.from(
        JSON.stringify({
          model: this.profile.model,
          input: texts,
          encoding_format: 'float',
        }),
      ),
      personal: true,
      allowedOrigins: this.allowedOrigins,
      signal: bounded,
    })
    if (response.statusCode !== 200) {
      response.destroy()
      throw new ApiError(
        502,
        `Embedding 供应商请求失败（${response.statusCode}）`,
      )
    }
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of response) {
      bytes += chunk.length
      if (bytes > 4 * 1024 * 1024) {
        response.destroy()
        throw new ApiError(502, 'Embedding 响应超过资源限制')
      }
      chunks.push(Buffer.from(chunk))
    }
    let body: { data?: { index: number; embedding: unknown }[] }
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body
    } catch {
      throw new ApiError(502, 'Embedding 响应不是有效 JSON')
    }
    if (
      !Array.isArray(body.data) ||
      body.data.length !== texts.length ||
      new Set(body.data.map((row) => row.index)).size !== texts.length ||
      body.data.some(
        (row) =>
          !Number.isInteger(row.index) ||
          row.index < 0 ||
          row.index >= texts.length,
      )
    )
      throw new ApiError(502, 'Embedding 响应索引无效')
    return validateVectors(
      body.data.sort((a, b) => a.index - b.index).map((row) => row.embedding),
      texts.length,
      this.profile.dimensions,
    )
  }
}
