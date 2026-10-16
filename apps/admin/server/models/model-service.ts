import { createHash, randomBytes } from 'node:crypto'
import { ApiError, object, requiredText, utcNow } from '../http/api-router.ts'
import type {
  Database,
  Row,
  SqlConnection,
} from '../infrastructure/database.ts'
import {
  createModelCredentialCipher,
  modelCredentialIdentity,
} from '../identity/model-credentials.ts'

export type ModelProtocol =
  'openai-completions' | 'openai-responses' | 'anthropic-messages'
export interface ModelDefinition {
  modelId: string
  name: string
  contextWindow: number | null
  maxTokens: number | null
  inputTypes: ('text' | 'image')[]
}
export interface ModelSelection {
  providerId: string
  modelId: string
}
export interface ProviderWrite {
  name: string
  protocol: ModelProtocol
  baseUrl: string
  models: ModelDefinition[]
  enabled: boolean
  apiKey: string | null
  clearApiKey: boolean
}
export interface ProviderView {
  providerId: string
  name: string
  protocol: ModelProtocol
  baseUrl: string
  models: ModelDefinition[]
  enabled: boolean
  apiKeyConfigured: boolean
  createdAt: string
  updatedAt: string
  source: 'personal' | 'platform'
}
export type Audit = (
  actor: string,
  action: string,
  target: string,
  detail?: Record<string, unknown>,
) => Promise<void>
const protocols = new Set([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
])

export function validateProvider(value: unknown): ProviderWrite {
  const input = object(value)
  const allowed = new Set([
    'name',
    'protocol',
    'baseUrl',
    'models',
    'enabled',
    'apiKey',
    'clearApiKey',
  ])
  if (Object.keys(input).some((key) => !allowed.has(key)))
    throw new ApiError(422, 'unknown provider field')
  const protocol = requiredText(input.protocol, 'protocol') as ModelProtocol
  if (!protocols.has(protocol))
    throw new ApiError(422, 'unsupported model protocol')
  const baseUrl = requiredText(input.baseUrl, 'baseUrl')
    .trim()
    .replace(/\/+$/, '')
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new ApiError(422, 'invalid model address')
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
      'model address must be HTTP(S) without credentials, query or fragment',
    )
  if (
    !Array.isArray(input.models) ||
    !input.models.length ||
    input.models.length > 100
  )
    throw new ApiError(422, 'one to 100 models required')
  const models = input.models.map((raw): ModelDefinition => {
    const item = object(raw)
    if (
      Object.keys(item).some(
        (key) =>
          ![
            'modelId',
            'name',
            'contextWindow',
            'maxTokens',
            'inputTypes',
          ].includes(key),
      )
    )
      throw new ApiError(422, 'unknown model field')
    const positive = (value: unknown): number | null => {
      if (value === undefined || value === null) return null
      if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value <= 0
      )
        throw new ApiError(422, 'model token limits must be positive integers')
      return value
    }
    const types = item.inputTypes ?? ['text']
    if (
      !Array.isArray(types) ||
      types.some((type) => !['text', 'image'].includes(type))
    )
      throw new ApiError(422, 'invalid model input types')
    return {
      modelId: requiredText(item.modelId, 'modelId', 200),
      name: requiredText(item.name, 'model name', 200),
      contextWindow: positive(item.contextWindow),
      maxTokens: positive(item.maxTokens),
      inputTypes: types as ('text' | 'image')[],
    }
  })
  if (new Set(models.map((model) => model.modelId)).size !== models.length)
    throw new ApiError(422, 'model IDs must be unique within a provider')
  for (const key of ['enabled', 'clearApiKey'])
    if (input[key] !== undefined && typeof input[key] !== 'boolean')
      throw new ApiError(422, `${key} must be boolean`)
  if (
    input.apiKey !== undefined &&
    input.apiKey !== null &&
    (typeof input.apiKey !== 'string' || input.apiKey.length > 8192)
  )
    throw new ApiError(422, 'invalid provider key')
  if (input.apiKey && input.clearApiKey)
    throw new ApiError(
      422,
      'apiKey and clearApiKey cannot be supplied together',
    )
  return {
    name: requiredText(input.name, 'name', 100),
    protocol,
    baseUrl,
    models,
    enabled: input.enabled !== false,
    apiKey: (input.apiKey as string | null) ?? null,
    clearApiKey: input.clearApiKey === true,
  }
}

function selection(value: unknown): ModelSelection | null {
  if (value === null || value === undefined) return null
  const input = object(value)
  return {
    providerId: requiredText(input.providerId, 'providerId', 200),
    modelId: requiredText(input.modelId, 'modelId', 200),
  }
}
function view(row: Row): ProviderView {
  return {
    providerId: String(row.id),
    name: String(row.name),
    protocol: row.protocol as ModelProtocol,
    baseUrl: String(row.base_url),
    models: JSON.parse(String(row.models_json)) as ModelDefinition[],
    enabled: Boolean(row.enabled),
    apiKeyConfigured: Boolean(row.key_ciphertext),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    source: row.owner_user_id ? 'personal' : 'platform',
  }
}

export class ModelService {
  readonly db: Database
  private readonly key: string
  private readonly audit: Audit
  private readonly listeners = new Set<(owner: string | null) => void>()
  constructor(options: { db: Database; encryptionKey: string; audit: Audit }) {
    this.db = options.db
    this.key = options.encryptionKey
    this.audit = options.audit
  }
  seal(value: string, identity: string): string {
    return createModelCredentialCipher(this.key).seal(value, identity)
  }
  open(value: string, identity: string): string {
    return createModelCredentialCipher(this.key).open(value, identity)
  }
  onChanged(listener: (owner: string | null) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private changed(owner: string | null): void {
    for (const listener of this.listeners) listener(owner)
  }
  private async lock(conn: SqlConnection): Promise<void> {
    await conn.query('SELECT pg_advisory_xact_lock(734521903)')
  }
  async list(owner: string | null = null): Promise<ProviderView[]> {
    return (
      await this.db.query(
        'SELECT * FROM platform_model_providers WHERE owner_user_id IS NOT DISTINCT FROM $1 ORDER BY name,id',
        [owner],
      )
    ).map(view)
  }
  async default(owner: string | null = null): Promise<ModelSelection | null> {
    const row = (
      await this.db.query(
        'SELECT provider_id,model_id FROM platform_model_defaults WHERE id=$1',
        [owner ? `user:${owner}` : 'global'],
      )
    )[0]
    return row
      ? { providerId: String(row.provider_id), modelId: String(row.model_id) }
      : null
  }
  async save(
    input: unknown,
    actor: string,
    owner: string | null = null,
    providerId?: string,
  ): Promise<ProviderView> {
    const value = validateProvider(input)
    const creating = !providerId
    const id =
      providerId ??
      `${owner ? 'personal' : 'platform'}-${randomBytes(8).toString('hex')}`
    const now = utcNow()
    const result = await this.db.transaction(async (conn) => {
      await this.lock(conn)
      const row = (
        await conn.query(
          'SELECT * FROM platform_model_providers WHERE id=$1 AND owner_user_id IS NOT DISTINCT FROM $2 FOR UPDATE',
          [id, owner],
        )
      )[0]
      if (!row && !creating) throw new ApiError(404, 'provider not found')
      const selected = await conn.query(
        'SELECT model_id FROM platform_model_defaults WHERE provider_id=$1',
        [id],
      )
      if (
        selected.some(
          (item) =>
            !value.enabled ||
            !value.models.some((model) => model.modelId === item.model_id),
        )
      )
        throw new ApiError(
          422,
          'change the default selection before disabling or removing its model',
        )
      const ciphertext = value.apiKey
        ? this.seal(
            value.apiKey,
            modelCredentialIdentity(id, owner ?? undefined),
          )
        : value.clearApiKey
          ? null
          : (row?.key_ciphertext ?? null)
      const values = [
        id,
        owner,
        value.name,
        value.protocol,
        value.baseUrl,
        ciphertext,
        JSON.stringify(value.models),
        Number(value.enabled),
        now,
      ]
      const rows = creating
        ? await conn.query(
            'INSERT INTO platform_model_providers(id,owner_user_id,name,protocol,base_url,key_ciphertext,models_json,enabled,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *',
            values,
          )
        : await conn.query(
            'UPDATE platform_model_providers SET name=$3,protocol=$4,base_url=$5,key_ciphertext=$6,models_json=$7,enabled=$8,updated_at=$9 WHERE id=$1 AND owner_user_id IS NOT DISTINCT FROM $2 RETURNING *',
            values,
          )
      return view(rows[0]!)
    })
    await this.audit(actor, 'models.provider.save', id)
    this.changed(owner)
    return result
  }
  async remove(
    id: string,
    actor: string,
    owner: string | null = null,
  ): Promise<void> {
    await this.db.transaction(async (conn) => {
      await this.lock(conn)
      const rows = await conn.query(
        'SELECT id FROM platform_model_providers WHERE id=$1 AND owner_user_id IS NOT DISTINCT FROM $2 FOR UPDATE',
        [id, owner],
      )
      if (!rows.length) throw new ApiError(404, 'provider not found')
      await conn.query(
        'DELETE FROM platform_model_defaults WHERE provider_id=$1',
        [id],
      )
      await conn.query(
        'DELETE FROM platform_model_providers WHERE id=$1 AND owner_user_id IS NOT DISTINCT FROM $2',
        [id, owner],
      )
    })
    await this.audit(actor, 'models.provider.delete', id)
    this.changed(owner)
  }
  async setDefault(
    raw: unknown,
    actor: string,
    owner: string | null = null,
  ): Promise<ModelSelection | null> {
    const value = selection(raw)
    const id = owner ? `user:${owner}` : 'global'
    await this.db.transaction(async (conn) => {
      await this.lock(conn)
      if (value) {
        const row = (
          await conn.query(
            'SELECT * FROM platform_model_providers WHERE id=$1 AND owner_user_id IS NOT DISTINCT FROM $2 FOR UPDATE',
            [value.providerId, owner],
          )
        )[0]
        if (
          !row ||
          !row.enabled ||
          !view(row).models.some((model) => model.modelId === value.modelId)
        )
          throw new ApiError(
            422,
            'default must select an enabled configured model',
          )
      }
      await conn.query('DELETE FROM platform_model_defaults WHERE id=$1', [id])
      if (value)
        await conn.query(
          'INSERT INTO platform_model_defaults(id,provider_id,model_id,updated_at) VALUES($1,$2,$3,$4)',
          [id, value.providerId, value.modelId, utcNow()],
        )
    })
    await this.audit(actor, 'models.default.save', id)
    this.changed(owner)
    return value
  }
  async catalog(owner: string): Promise<Record<string, unknown>> {
    const [personal, platform, personalDefault, platformDefault] =
      await Promise.all([
        this.list(owner),
        this.list(),
        this.default(owner),
        this.default(),
      ])
    return {
      scope: createHash('sha256').update(`user:${owner}`).digest('hex'),
      providers: [...personal, ...platform]
        .filter((provider) => provider.enabled)
        .map(({ providerId, name, protocol, models, source }) => ({
          providerId,
          name,
          protocol,
          models,
          source,
        })),
      default: personalDefault ?? platformDefault,
      personalDefault,
      platformDefault,
      serverTime: utcNow(),
    }
  }
  async resolve(
    owner: string,
    id: string,
    protocol: string,
    modelId: string,
  ): Promise<{ baseUrl: string; key: string | null; personal: boolean }> {
    const row = (
      await this.db.query(
        'SELECT * FROM platform_model_providers WHERE id=$1 AND (owner_user_id=$2 OR owner_user_id IS NULL)',
        [id, owner],
      )
    )[0]
    if (!row || !row.enabled || row.protocol !== protocol)
      throw new ApiError(404, 'model provider unavailable')
    if (!view(row).models.some((model) => model.modelId === modelId))
      throw new ApiError(422, 'requested model is unavailable')
    return {
      baseUrl: String(row.base_url),
      key: row.key_ciphertext
        ? this.open(
            String(row.key_ciphertext),
            modelCredentialIdentity(id, row.owner_user_id ? owner : undefined),
          )
        : null,
      personal: Boolean(row.owner_user_id),
    }
  }
}
