import { createHash, randomUUID } from 'node:crypto'
import type { Database, Row } from '../infrastructure/database.ts'
import {
  ApiError,
  integer,
  requiredText,
  text,
  utcNow,
  type Account,
} from '../http/api-router.ts'
import {
  createModelCredentialCipher,
  modelCredentialIdentity,
} from '../identity/model-credentials.ts'
import type {
  CapabilityBinding,
  ModelAdapter,
  ModelCapability,
  ModelConfiguration,
  ProviderConnection,
} from '@superdsh/core/contracts/platform'
import {
  capability,
  modelAdapters,
  modelCapabilities,
  validateModelParameters,
} from './capabilities.ts'
import { synchronizeLegacyConnections } from './connection-compatibility.ts'

const configView = (row: Row): ModelConfiguration => ({
  id: text(row.id),
  name: text(row.name),
  kind: row.kind as ModelConfiguration['kind'],
  capability: row.capability as ModelCapability,
  connectionId: text(row.connection_id),
  modelId: text(row.model_id),
  revision: Number(row.revision),
  enabled: Boolean(row.enabled),
  parameters: JSON.parse(text(row.parameters_json)),
  roleIds: JSON.parse(text(row.roles_json)),
})
const connectionView = (row: Row): ProviderConnection => ({
  id: text(row.id),
  name: text(row.name),
  adapter: row.adapter as ModelAdapter,
  baseUrl: text(row.base_url),
  region: text(row.region),
  enabled: Boolean(row.enabled),
  revision: Number(row.revision),
  credentialConfigured: Boolean(row.credential_ciphertext),
  scope: row.owner_user_id ? 'personal' : 'platform',
})
export class ModelConfigurationService {
  readonly options: {
    db: Database
    encryptionKey: string
    changed?: () => void
  }
  private readonly cipher: ReturnType<typeof createModelCredentialCipher>
  constructor(options: ModelConfigurationService['options']) {
    this.options = options
    this.cipher = createModelCredentialCipher(options.encryptionKey)
  }
  async synchronize() {
    await synchronizeLegacyConnections(
      this.options.db,
      this.options.encryptionKey,
    )
  }
  async connections() {
    await this.synchronize()
    return (
      await this.options.db.query(
        'SELECT * FROM model_connections WHERE owner_user_id IS NULL ORDER BY name,id',
      )
    ).map(connectionView)
  }
  async configurations() {
    await this.synchronize()
    return (
      await this.options.db.query(
        'SELECT m.* FROM model_configurations m JOIN model_connections c ON c.id=m.connection_id WHERE c.owner_user_id IS NULL ORDER BY m.name,m.id',
      )
    ).map(configView)
  }
  async defaults() {
    return (
      await this.options.db.query(
        'SELECT capability,configuration_id,revision FROM model_capability_defaults',
      )
    ).map((row) => ({
      capability: row.capability,
      configurationId: row.configuration_id,
      revision: Number(row.revision),
    }))
  }
  async saveConnection(id: string | undefined, body: Row) {
    const adapter = requiredText(body.adapter, '供应商服务类型') as ModelAdapter
    if (!modelAdapters.includes(adapter))
      throw new ApiError(422, '不支持的供应商服务类型')
    const address = requiredText(body.baseUrl, '供应商地址')
    if (!URL.canParse(address)) throw new ApiError(422, '供应商地址格式不正确')
    const base = new URL(address)
    if (
      !['https:', 'http:'].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      throw new ApiError(422, '供应商地址格式不正确')
    const name = requiredText(body.name, '连接名称', 100),
      connectionId = id || 'connection_' + randomUUID().replaceAll('-', '')
    await this.options.db.transaction(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(734521903)')
      const [old] = await db.query(
        'SELECT * FROM model_connections WHERE id=$1 AND owner_user_id IS NULL FOR UPDATE',
        [connectionId],
      )
      if (id && !old) throw new ApiError(404, '连接不存在')
      if (old && Number(body.revision) !== Number(old.revision))
        throw new ApiError(409, '连接已修改，请刷新后重试')
      if (
        old &&
        (old.adapter !== adapter ||
          old.base_url !== base.href.replace(/\/$/, ''))
      ) {
        const used = await db.query(
          'SELECT id FROM model_configurations WHERE connection_id=$1 LIMIT 1',
          [id],
        )
        if (used.length)
          throw new ApiError(
            409,
            '已引用连接不能更改协议或地址，请新增连接和配置版本',
          )
      }
      const key =
        body.clearApiKey === true
          ? ''
          : body.apiKey === undefined
            ? undefined
            : requiredText(body.apiKey, 'API Key')
      const identity = 'connection:' + connectionId
      const encrypted =
        key === undefined
          ? old?.credential_ciphertext || null
          : key
            ? this.cipher.seal(key, identity)
            : null
      await db.query(
        `INSERT INTO model_connections(id,name,adapter,base_url,region,credential_ciphertext,credential_identity,enabled,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
        ON CONFLICT(id) DO UPDATE SET name=$2,adapter=$3,base_url=$4,region=$5,credential_ciphertext=$6,credential_identity=$7,enabled=$8,revision=model_connections.revision+1,updated_at=$9`,
        [
          connectionId,
          name,
          adapter,
          base.href.replace(/\/$/, ''),
          text(body.region),
          encrypted,
          identity,
          body.enabled === false ? 0 : 1,
          utcNow(),
        ],
      )
      if (old?.legacy_provider_id) {
        const plain = encrypted
          ? this.cipher.open(text(encrypted), identity)
          : ''
        await db.query(
          'UPDATE platform_model_providers SET name=$2,enabled=$3,key_ciphertext=$4,updated_at=$5 WHERE id=$1',
          [
            old.legacy_provider_id,
            name,
            body.enabled === false ? 0 : 1,
            plain
              ? this.cipher.seal(
                  plain,
                  modelCredentialIdentity(text(old.legacy_provider_id)),
                )
              : null,
            utcNow(),
          ],
        )
      }
    })
    this.options.changed?.()
    return (await this.connections()).find(
      (entry) => entry.id === connectionId,
    )!
  }
  async saveConfiguration(id: string | undefined, body: Row) {
    const connectionId = requiredText(body.connectionId, '供应商连接'),
      name = requiredText(body.name, '配置名称', 100)
    const descriptor = capability(requiredText(body.capability, '能力'))
    const modelId = requiredText(body.modelId, '模型 ID', 200)
    const configurationId = id || 'model_' + randomUUID().replaceAll('-', '')
    let result!: ModelConfiguration
    await this.options.db.transaction(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(734521903)')
      const [connection] = await db.query(
        'SELECT * FROM model_connections WHERE id=$1 AND owner_user_id IS NULL',
        [connectionId],
      )
      if (!connection) throw new ApiError(404, '供应商连接不存在')
      if (
        descriptor.id === 'chat' &&
        (
          await db.query(
            "SELECT id FROM model_configurations WHERE connection_id=$1 AND model_id=$2 AND kind='chat' AND id<>$3",
            [connectionId, modelId, configurationId],
          )
        ).length
      )
        throw new ApiError(409, '此连接已配置相同聊天模型，请编辑已有配置')
      const parameters = validateModelParameters(
        connection.adapter as ModelAdapter,
        descriptor.id,
        modelId,
        body.parameters,
      )
      const roles = body.roleIds ?? []
      if (
        !Array.isArray(roles) ||
        roles.some((role) => typeof role !== 'string')
      )
        throw new ApiError(422, '角色范围格式不正确')
      if (
        roles.length &&
        (
          await db.query('SELECT id FROM roles WHERE id=ANY($1::text[])', [
            roles,
          ])
        ).length !== new Set(roles).size
      )
        throw new ApiError(422, '配置引用了不存在的角色')
      const [old] = await db.query(
        'SELECT * FROM model_configurations WHERE id=$1 FOR UPDATE',
        [configurationId],
      )
      if (id && !old) throw new ApiError(404, '模型配置不存在')
      if (old && Number(body.revision) !== Number(old.revision))
        throw new ApiError(409, '模型配置已修改，请刷新后重试')
      if (old && old.capability !== descriptor.id)
        throw new ApiError(409, '配置能力类型不可修改，请新增配置')
      if (old && old.connection_id !== connectionId)
        throw new ApiError(
          409,
          '已有版本的连接不可替换，请创建新配置并显式选择',
        )
      const revision = old ? Number(old.revision) + 1 : 1,
        now = utcNow()
      result = {
        id: configurationId,
        name,
        connectionId,
        capability: descriptor.id,
        kind: descriptor.id === 'chat' ? 'chat' : 'multimodal',
        modelId,
        parameters,
        revision,
        enabled: body.enabled !== false,
        roleIds: [...new Set(roles)],
      }
      await db.query(
        `INSERT INTO model_configurations(id,connection_id,name,kind,capability,model_id,revision,enabled,parameters_json,roles_json,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
        ON CONFLICT(id) DO UPDATE SET connection_id=$2,name=$3,model_id=$6,revision=$7,enabled=$8,parameters_json=$9,roles_json=$10,updated_at=$11`,
        [
          configurationId,
          connectionId,
          name,
          result.kind,
          descriptor.id,
          modelId,
          revision,
          result.enabled ? 1 : 0,
          JSON.stringify(parameters),
          JSON.stringify(result.roleIds),
          now,
        ],
      )
      await db.query(
        'INSERT INTO model_configuration_versions(configuration_id,revision,definition_json,created_at) VALUES($1,$2,$3,$4)',
        [configurationId, revision, JSON.stringify(result), now],
      )
      if (result.kind === 'chat') {
        const models = await db.query(
          "SELECT model_id,name,parameters_json FROM model_configurations WHERE connection_id=$1 AND kind='chat' AND enabled=1",
          [connectionId],
        )
        // Older configuration versions did not carry the legacy model's full
        // capabilities. Editing a name or access policy must not erase them.
        const [legacy] = await db.query(
          'SELECT models_json FROM platform_model_providers WHERE id=$1',
          [connectionId],
        )
        const legacyModels: Row[] = JSON.parse(text(legacy?.models_json, '[]'))
        const projectedModels = models.map((row) => {
          const previous = legacyModels.find(
            (item) => item.modelId === row.model_id,
          )
          const parameters = JSON.parse(text(row.parameters_json)) as Row
          return {
            modelId: row.model_id,
            name: row.name,
            contextWindow:
              parameters.contextWindow ?? previous?.contextWindow ?? null,
            maxTokens: parameters.maxTokens ?? previous?.maxTokens ?? 4096,
            inputTypes: previous?.inputTypes ?? ['text', 'image'],
          }
        })
        const protocol =
          connection.adapter === 'volcengine-ark'
            ? 'openai-responses'
            : connection.adapter
        const plain = connection.credential_ciphertext
          ? this.cipher.open(
              text(connection.credential_ciphertext),
              text(connection.credential_identity),
            )
          : ''
        await db.query(
          `INSERT INTO platform_model_providers(id,name,protocol,base_url,key_ciphertext,models_json,enabled,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)
          ON CONFLICT(id) DO UPDATE SET models_json=$6,updated_at=$8`,
          [
            connectionId,
            connection.name,
            protocol,
            connection.base_url,
            plain
              ? this.cipher.seal(plain, modelCredentialIdentity(connectionId))
              : null,
            JSON.stringify(projectedModels),
            connection.enabled,
            now,
          ],
        )
        await db.query(
          'UPDATE model_connections SET legacy_provider_id=$1 WHERE id=$1',
          [connectionId],
        )
      }
    })
    this.options.changed?.()
    return result
  }
  async setDefault(
    id: ModelCapability,
    configurationId: string | null,
    revision?: number,
  ) {
    capability(id)
    await this.options.db.transaction(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(734521903)')
      const [old] = await db.query(
        'SELECT revision FROM model_capability_defaults WHERE capability=$1 FOR UPDATE',
        [id],
      )
      if (revision !== undefined && revision !== Number(old?.revision || 0))
        throw new ApiError(409, '默认配置已修改，请刷新后重试')
      const [config] = configurationId
        ? await db.query(
            'SELECT m.* FROM model_configurations m JOIN model_connections c ON c.id=m.connection_id WHERE m.id=$1 AND m.capability=$2 AND m.enabled=1 AND c.enabled=1 AND c.owner_user_id IS NULL',
            [configurationId, id],
          )
        : []
      if (configurationId && !config)
        throw new ApiError(422, '默认配置不存在、已停用或能力不匹配')
      await db.query(
        'INSERT INTO model_capability_defaults(capability,configuration_id,updated_at) VALUES($1,$2,$3) ON CONFLICT(capability) DO UPDATE SET configuration_id=$2,revision=model_capability_defaults.revision+1,updated_at=$3',
        [id, configurationId, utcNow()],
      )
      if (id === 'chat' && config)
        await db.query(
          "INSERT INTO platform_model_defaults(id,provider_id,model_id,updated_at) VALUES('global',$1,$2,$3) ON CONFLICT(id) DO UPDATE SET provider_id=$1,model_id=$2,updated_at=$3",
          [config.connection_id, config.model_id, utcNow()],
        )
      else if (id === 'chat')
        await db.query("DELETE FROM platform_model_defaults WHERE id='global'")
    })
    this.options.changed?.()
  }
  async bind(
    account: Account,
    id: string | undefined,
    expected: ModelCapability,
  ): Promise<CapabilityBinding> {
    const selected =
      id ||
      text(
        (
          await this.options.db.query(
            'SELECT configuration_id FROM model_capability_defaults WHERE capability=$1',
            [expected],
          )
        )[0]?.configuration_id,
      )
    if (!selected)
      throw new ApiError(422, '尚未配置此能力的模型，请在模型管理中配置')
    const [row] = await this.options.db.query(
      'SELECT revision FROM model_configurations WHERE id=$1',
      [selected],
    )
    if (!row) throw new ApiError(404, '模型配置不存在')
    const binding = {
      configurationId: selected,
      revision: Number(row.revision),
      capability: expected,
    }
    await this.resolve(account, binding)
    return binding
  }
  async importLegacyImage(
    owner: string,
    tool: string,
    version: number,
    settings: Row,
    key: string,
  ): Promise<CapabilityBinding> {
    const suffix = createHash('sha256')
      .update(JSON.stringify([owner, tool, version]))
      .digest('hex')
      .slice(0, 32)
    const connectionId = 'legacy_image_' + suffix,
      id = 'image_' + suffix
    const parameters = validateModelParameters(
      'openai-completions',
      'image.generate',
      text(settings.model),
      { size: text(settings.size, '1536x1024'), maxImages: 1 },
    )
    const definition: ModelConfiguration = {
      id,
      name: '历史配图工具 · ' + tool,
      connectionId,
      modelId: requiredText(settings.model, '历史生图模型'),
      capability: 'image.generate',
      kind: 'multimodal',
      revision: 1,
      enabled: true,
      parameters,
      roleIds: [],
    }
    const baseUrl = new URL(requiredText(settings.baseUrl, '历史生图地址'))
    if (
      !['http:', 'https:'].includes(baseUrl.protocol) ||
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.search ||
      baseUrl.hash
    )
      throw new ApiError(422, '历史生图服务地址无效')
    if (!key)
      throw new ApiError(422, '历史生图工具缺少凭据，请在多模态模型管理中配置')
    await this.options.db.transaction(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(734521903)')
      await db.query(
        `INSERT INTO model_connections(id,name,adapter,base_url,credential_ciphertext,credential_identity,created_at,updated_at) VALUES($1,$2,'openai-completions',$3,$4,$5,$6,$6) ON CONFLICT DO NOTHING`,
        [
          connectionId,
          definition.name,
          baseUrl.href
            .replace(/\/+$/, '')
            .replace(/\/images\/generations$/, ''),
          this.cipher.seal(key, 'connection:' + connectionId),
          'connection:' + connectionId,
          utcNow(),
        ],
      )
      await db.query(
        `INSERT INTO model_configurations(id,connection_id,name,kind,capability,model_id,parameters_json,created_at,updated_at) VALUES($1,$2,$3,'multimodal','image.generate',$4,$5,$6,$6) ON CONFLICT DO NOTHING`,
        [
          id,
          connectionId,
          definition.name,
          definition.modelId,
          JSON.stringify(parameters),
          utcNow(),
        ],
      )
      await db.query(
        'INSERT INTO model_configuration_versions(configuration_id,revision,definition_json,created_at) VALUES($1,1,$2,$3) ON CONFLICT DO NOTHING',
        [id, JSON.stringify(definition), utcNow()],
      )
    })
    return { configurationId: id, revision: 1, capability: 'image.generate' }
  }
  async resolve(account: Account, binding: CapabilityBinding) {
    if (
      account.disabled ||
      account.deletedAt ||
      account.resetRequired ||
      !account.permissions.includes('models.use')
    )
      throw new ApiError(403, '模型使用权限已撤销')
    const [row] = await this.options.db.query(
      `SELECT m.enabled,m.roles_json,v.definition_json FROM model_configurations m JOIN model_configuration_versions v ON v.configuration_id=m.id WHERE m.id=$1 AND v.revision=$2`,
      [binding.configurationId, integer(binding.revision, 0, 1)],
    )
    if (!row?.enabled) throw new ApiError(403, '模型配置已停用或版本不存在')
    const currentRoles: string[] = JSON.parse(text(row.roles_json))
    const configuration = JSON.parse(
      text(row.definition_json),
    ) as ModelConfiguration
    if (
      configuration.capability !== binding.capability ||
      !configuration.enabled ||
      !capability(binding.capability).available
    )
      throw new ApiError(403, '模型能力不匹配或不可用')
    if (
      [currentRoles, configuration.roleIds].some(
        (roles) =>
          roles.length && !roles.some((role) => account.roles.includes(role)),
      )
    )
      throw new ApiError(403, '当前角色无权使用此模型配置')
    const [connection] = await this.options.db.query(
      'SELECT * FROM model_connections WHERE id=$1 AND owner_user_id IS NULL',
      [configuration.connectionId],
    )
    if (!connection?.enabled) throw new ApiError(403, '供应商连接已停用')
    if (!connection.credential_ciphertext)
      throw new ApiError(422, '供应商尚未配置凭据')
    return {
      configuration,
      connection: connectionView(connection),
      key: this.cipher.open(
        text(connection.credential_ciphertext),
        text(connection.credential_identity),
      ),
    }
  }
  async authorizeChat(account: Account, provider: string, model: string) {
    await this.synchronize()
    const [connection] = await this.options.db.query(
      'SELECT * FROM model_connections WHERE id=$1 AND owner_user_id IS NULL',
      [provider],
    )
    if (!connection) return
    const [configuration] = await this.options.db.query(
      "SELECT id,revision FROM model_configurations WHERE connection_id=$1 AND model_id=$2 AND kind='chat' AND enabled=1 ORDER BY id LIMIT 1",
      [provider, model],
    )
    if (!configuration) throw new ApiError(403, '聊天模型配置已停用')
    await this.resolve(account, {
      configurationId: text(configuration.id),
      revision: Number(configuration.revision),
      capability: 'chat',
    })
    return connection.adapter === 'volcengine-ark'
  }
  async catalog(account: Account) {
    const configurations: ModelConfiguration[] = []
    for (const config of await this.configurations()) {
      try {
        await this.resolve(account, {
          configurationId: config.id,
          revision: config.revision,
          capability: config.capability,
        })
        configurations.push(config)
      } catch {
        /* Only usable authorized configurations are exposed. */
      }
    }
    return {
      capabilities: modelCapabilities,
      configurations,
      defaults: (await this.defaults()).filter((entry) =>
        configurations.some((config) => config.id === entry.configurationId),
      ),
    }
  }
}
