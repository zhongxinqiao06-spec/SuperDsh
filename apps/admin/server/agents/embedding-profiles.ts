import { createHash } from 'node:crypto'
import {
  ApiError,
  integer,
  requiredText,
  text,
  utcNow,
  type Account,
  type ApiRouter,
} from '../http/api-router.ts'
import { json, type Database, type Row } from '../infrastructure/database.ts'
import { createModelCredentialCipher } from '../identity/model-credentials.ts'
import { requirePermission } from '../conversations/store.ts'
import {
  LocalKnowledgeEmbedding,
  ExternalKnowledgeEmbedding,
  requireTrustedEmbeddingOrigin,
} from './embedding.ts'
import { LOCAL_EMBEDDING, prepareEmbeddingModel } from './embedding-model.ts'
import type {
  EmbeddingProfile,
  KnowledgeEmbedding,
} from './knowledge-contracts.ts'
import type { QdrantKnowledgeIndex } from './knowledge-index.ts'

const settingKey = 'knowledge.embedding.profile.v1'
const credentialIdentity = 'knowledge:embedding:profile:v1'
interface StoredProfile {
  version: number
  profile: EmbeddingProfile
  encryptedKey: string | null
}
interface Options {
  db: Database
  encryptionKey: string
  localModelDirectory: string
  allowedOrigins?: string
  trustedOrigins?: string
  deploymentDefault?: string
  getAccount(userId: string): Promise<Account>
  audit(
    actor: string,
    action: string,
    target: string,
    detail?: Record<string, unknown>,
  ): Promise<void>
}

export class KnowledgeEmbeddingProfiles {
  readonly options: Options
  private current: StoredProfile = {
    version: 0,
    profile: { ...LOCAL_EMBEDDING },
    encryptedKey: null,
  }
  private provider: KnowledgeEmbedding
  constructor(options: Options) {
    this.options = options
    this.provider = new LocalKnowledgeEmbedding(options.localModelDirectory)
  }
  async initialize() {
    const [row] = await this.options.db.query(
      'SELECT value FROM instance_settings WHERE key=$1',
      [settingKey],
    )
    const stored = json<StoredProfile | null>(row?.value, null)
    if (stored) {
      this.current = stored
      this.provider = this.build(stored)
    } else if (this.options.deploymentDefault) {
      // 部署默认值只用于尚未保存检索设置的实例。管理员保存后始终使用数据库内的版本。
      const { model, revision, dimensions, baseUrl } = JSON.parse(
        this.options.deploymentDefault,
      )
      const candidate = this.candidate({
        kind: 'openai-compatible',
        model,
        revision,
        dimensions,
        baseUrl,
      })
      this.provider = this.build(candidate)
      this.current = { ...candidate, version: 0 }
    }
  }
  embedding = () => this.provider
  view() {
    return {
      version: this.current.version,
      profile: {
        ...this.current.profile,
        apiKeyConfigured: Boolean(this.current.encryptedKey),
      },
      localDefault: { ...LOCAL_EMBEDDING },
    }
  }
  private build(stored: StoredProfile): KnowledgeEmbedding {
    if (stored.profile.kind === 'local')
      return new LocalKnowledgeEmbedding(this.options.localModelDirectory)
    const key = stored.encryptedKey
      ? createModelCredentialCipher(this.options.encryptionKey).open(
          stored.encryptedKey,
          credentialIdentity,
        )
      : ''
    return new ExternalKnowledgeEmbedding(
      stored.profile,
      key,
      this.options.allowedOrigins ??
        process.env.SUPERDSH_PERSONAL_MODEL_ALLOWED_ORIGINS ??
        '',
      this.options.trustedOrigins ?? '',
    )
  }
  async prepareLocal(signal?: AbortSignal) {
    await prepareEmbeddingModel(this.options.localModelDirectory, signal)
    return { ready: true, profile: LOCAL_EMBEDDING }
  }
  private candidate(input: Row): StoredProfile {
    const allowed = new Set([
      'kind',
      'model',
      'dimensions',
      'revision',
      'baseUrl',
      'apiKey',
      'clearApiKey',
      'version',
    ])
    if (Object.keys(input).some((key) => !allowed.has(key)))
      throw new ApiError(422, '未知 Embedding 设置字段')
    if (input.kind === 'local')
      return {
        version: this.current.version + 1,
        profile: { ...LOCAL_EMBEDDING },
        encryptedKey: null,
      }
    if (input.kind !== 'openai-compatible')
      throw new ApiError(422, 'Embedding 类型必须为本地或 OpenAI 兼容接口')
    const baseUrl = requiredText(input.baseUrl, 'Embedding 地址', 2048).replace(
      /\/+$/,
      '',
    )
    let url: URL
    try {
      url = new URL(baseUrl)
    } catch {
      throw new ApiError(422, 'Embedding 地址无效')
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new ApiError(
        422,
        'Embedding 地址必须为无凭据、参数和片段的 HTTP(S) 地址',
      )
    requireTrustedEmbeddingOrigin(baseUrl, this.options.trustedOrigins ?? '')
    const model = requiredText(input.model, 'Embedding 模型', 200)
    const revision = requiredText(input.revision, '模型版本标识', 100)
    const dimensions = integer(input.dimensions, 0, 1, 4096)
    const profile: EmbeddingProfile = {
      id: `external_${createHash('sha256').update(`${baseUrl}:${model}:${revision}:${dimensions}`).digest('hex').slice(0, 20)}`,
      kind: 'openai-compatible',
      model,
      revision,
      dimensions,
      baseUrl,
    }
    const sameOrigin =
      this.current.profile.baseUrl &&
      new URL(this.current.profile.baseUrl).origin === url.origin
    let encryptedKey = sameOrigin ? this.current.encryptedKey : null
    if (input.clearApiKey === true) encryptedKey = null
    if (
      input.apiKey !== undefined &&
      input.apiKey !== null &&
      input.apiKey !== ''
    )
      encryptedKey = createModelCredentialCipher(
        this.options.encryptionKey,
      ).seal(
        requiredText(input.apiKey, 'Embedding API Key', 8192),
        credentialIdentity,
      )
    return { version: this.current.version + 1, profile, encryptedKey }
  }
  async save(
    actor: string,
    input: Row,
    index: QdrantKnowledgeIndex,
    signal: AbortSignal,
  ) {
    const authorize = async () => {
      const account = await this.options.getAccount(actor)
      requirePermission(account, 'models.manage')
      requirePermission(account, 'agents.manage')
    }
    await authorize()
    const expected = integer(input.version, -1, 0)
    const lease = await this.options.db.lease(
      'knowledge:embedding:configuration',
    )
    if (!lease)
      throw new ApiError(409, '另一个管理员正在准备语义索引，请稍后重试')
    const loss = new AbortController()
    void lease.lost.then((error) => loss.abort(error))
    const operationSignal = AbortSignal.any([signal, loss.signal])
    try {
      await this.initialize()
      if (expected !== this.current.version)
        throw new ApiError(409, 'Embedding 设置已更新，请刷新后重试')
      const candidate = this.candidate(input)
      const provider = this.build(candidate)
      await provider.ready(operationSignal)
      const authorizedProvider: KnowledgeEmbedding = {
        profile: provider.profile,
        ready: async (requestSignal) => {
          await authorize()
          return provider.ready(requestSignal)
        },
        embed: async (texts, purpose, requestSignal) => {
          await authorize()
          return provider.embed(texts, purpose, requestSignal)
        },
      }
      let cursor = '',
        indexedAssets = 0
      // New vectors go into a distinct generation; live searches keep the old provider until all documents succeed.
      for (;;) {
        operationSignal.throwIfAborted()
        await authorize()
        const assets = await this.options.db.query(
          "SELECT id,name,sha256,extracted_text,source_segments_json,owner_user_id FROM business_agent_assets WHERE kind='knowledge' AND id>$1 ORDER BY id LIMIT 50",
          [cursor],
        )
        if (!assets.length) break
        const owners = new Map<string, Row[]>()
        for (const row of assets) {
          const owner = text(row.owner_user_id)
          owners.set(owner, [...(owners.get(owner) ?? []), row])
        }
        for (const [owner, rows] of owners) {
          await authorize()
          await index.index(
            owner,
            rows,
            operationSignal,
            false,
            authorizedProvider,
          )
        }
        indexedAssets += assets.length
        cursor = text(assets.at(-1)!.id)
      }
      operationSignal.throwIfAborted()
      await authorize()
      await this.options.db.transaction(async (connection) => {
        await connection.query(
          'INSERT INTO instance_settings(key,value,updated_at) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at',
          [settingKey, JSON.stringify(candidate), utcNow()],
        )
      })
      this.current = candidate
      this.provider = provider
      await this.options.audit(
        actor,
        'knowledge.embedding.update',
        profileTarget(candidate.profile),
        {
          kind: candidate.profile.kind,
          model: candidate.profile.model,
          revision: candidate.profile.revision,
          indexedAssets,
        },
      )
      return this.view()
    } finally {
      await lease.release()
    }
  }
}

function profileTarget(profile: EmbeddingProfile) {
  return profile.id
}

export function registerEmbeddingProfileRoutes(
  router: ApiRouter,
  profiles: KnowledgeEmbeddingProfiles,
  index: QdrantKnowledgeIndex,
) {
  const options = { permission: 'models.manage' }
  router.add(
    'GET',
    '/admin/knowledge-embedding',
    () => profiles.view(),
    options,
  )
  router.add(
    'PUT',
    '/admin/knowledge-embedding',
    (ctx) => profiles.save(ctx.account!.userId, ctx.body, index, ctx.signal),
    options,
  )
  router.add(
    'POST',
    '/admin/knowledge-embedding/prepare-local',
    async (ctx) => {
      await ctx.user('agents.manage')
      const result = await profiles.prepareLocal(ctx.signal)
      await profiles.options.audit(
        ctx.account!.userId,
        'knowledge.embedding.prepare',
        LOCAL_EMBEDDING.id,
      )
      return result
    },
    options,
  )
}
