import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import type {
  BoundToolImplementation,
  ExtensionManifest,
  ExtensionSource,
  ToolImplementationRef,
  ToolImplementation,
} from '@superdsh/core/contracts/extensions'
import {
  ApiError,
  object,
  requiredText,
  text,
  utcNow,
  type Account,
} from '../http/api-router.ts'
import { requirePermission } from '../conversations/store.ts'
import {
  json,
  type Database,
  type Row,
  type SqlConnection,
} from '../infrastructure/database.ts'
import { createModelCredentialCipher } from '../identity/model-credentials.ts'
import {
  builtinSourceId,
  builtinTools,
  builtinVersion,
} from './builtin-tools.ts'
import { installArchive } from './installer.ts'
import { installedSkillArchive } from './skill-archive.ts'
import { callMcp, discoverMcp, withMcp } from './mcp.ts'
import { runToolProcess } from './process.ts'
import { extensionId, extensionVersion, validateValue } from './validation.ts'

const hash = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(value ?? null))
    .digest('hex')
const builtinDigest = hash(builtinTools)
const legacyBuiltinTools = JSON.parse(
  readFileSync(new URL('./builtin-tools-v2.json', import.meta.url), 'utf8'),
) as ToolImplementation[]
// Both shipped 2.0 manifests existed before the version was bumped. Preserve their
// exact descriptors and hashes; never accept arbitrary historical digests.
const initialBuiltinTools = JSON.parse(
  readFileSync(
    new URL('./builtin-tools-v2-initial.json', import.meta.url),
    'utf8',
  ),
) as ToolImplementation[]
const legacyManifests = new Map(
  [legacyBuiltinTools, initialBuiltinTools].map((tools) => [
    hash(tools),
    tools,
  ]),
)
export function builtinBinding(
  id: string,
  version = builtinVersion,
  digest?: string,
): BoundToolImplementation {
  if (![builtinVersion, '2.0.0'].includes(version))
    throw new ApiError(409, '内置工具版本不可用')
  const tools =
    version === '2.0.0'
      ? legacyManifests.get(digest || hash(legacyBuiltinTools))
      : builtinTools
  if (!tools || (digest && digest !== hash(tools)))
    throw new ApiError(409, '内置工具内容已改变，请绑定新版本')
  const descriptor = tools.find((item) => item.id === id)
  if (!descriptor)
    throw new ApiError(422, '工具实现不存在，请选择已安装的扩展工具')
  return {
    implementation: {
      sourceId: builtinSourceId,
      version,
      toolId: id,
      digest: hash(tools),
    },
    descriptor,
  }
}

type StoredManifest = Pick<ExtensionManifest, 'tools'> &
  Partial<ExtensionManifest> & { endpoint?: string }
interface SourceConfiguration {
  endpoint?: string
  encryptedToken?: string
}
export interface ExtensionServiceOptions {
  db: Database
  directory: string
  encryptionKey: string
  allowedOrigins: string
  audit(
    actor: string,
    action: string,
    target: string,
    detail?: Record<string, unknown>,
    connection?: SqlConnection,
  ): Promise<void>
}

export class ExtensionService {
  readonly options: ExtensionServiceOptions
  private readonly cipher: ReturnType<typeof createModelCredentialCipher>
  constructor(options: ExtensionServiceOptions) {
    this.options = options
    this.cipher = createModelCredentialCipher(options.encryptionKey)
  }

  async list(account: Account): Promise<ExtensionSource[]> {
    requirePermission(account, 'agents.manage')
    const rows = await this.options.db.query(
      'SELECT * FROM agent_extension_sources ORDER BY name,id',
    )
    const sources: ExtensionSource[] = [
      {
        id: builtinSourceId,
        name: 'SuperDsh 办公工具',
        kind: 'builtin',
        enabled: true,
        revision: 1,
        activeVersion: builtinVersion,
        status: 'ready',
        credentialConfigured: false,
        versions: [
          { version: builtinVersion, digest: builtinDigest, createdAt: '' },
          { version: '2.0.0', digest: hash(legacyBuiltinTools), createdAt: '' },
        ],
        tools: builtinTools,
        createdAt: '',
        updatedAt: '',
      },
    ]
    for (const row of rows) {
      const versions = await this.options.db.query(
        'SELECT version,digest,manifest_json,created_at FROM agent_extension_versions WHERE source_id=$1 ORDER BY created_at DESC',
        [row.id],
      )
      const manifest = json<StoredManifest>(
        versions.find((item) => item.version === row.active_version)
          ?.manifest_json,
        { tools: [] },
      )
      const config = json<SourceConfiguration>(row.configuration_json, {})
      sources.push({
        id: text(row.id),
        name: text(row.name),
        kind: row.kind as ExtensionSource['kind'],
        enabled: row.enabled === 1,
        revision: Number(row.revision),
        activeVersion: text(row.active_version),
        status: row.status as ExtensionSource['status'],
        diagnostic: text(row.diagnostic) || undefined,
        credentialConfigured: Boolean(config.encryptedToken),
        endpoint: config.endpoint,
        versions: versions.map((item) => ({
          version: text(item.version),
          digest: text(item.digest),
          createdAt: text(item.created_at),
        })),
        tools: manifest.tools,
        skills: manifest.skills?.map(
          ({ id, name, description, requiredToolIds }) => ({
            id,
            name,
            description,
            requiredToolIds,
          }),
        ),
        createdAt: text(row.created_at),
        updatedAt: text(row.updated_at),
      })
    }
    return sources
  }

  async install(account: Account, body: Row, signal: AbortSignal) {
    requirePermission(account, 'extensions.manage')
    const content = requiredText(
      body.contentBase64,
      '扩展 ZIP',
      24 * 1024 * 1024,
    )
    const bytes = Buffer.from(content, 'base64')
    if (bytes.toString('base64') !== content)
      throw new ApiError(422, '扩展包编码无效')
    const result = await installArchive({
      root: join(this.options.directory, 'packages'),
      bytes,
      signal,
    })
    if (result.manifest.id === builtinSourceId)
      throw new ApiError(409, '不能覆盖产品内置扩展')
    if (body.expectedSourceId && body.expectedSourceId !== result.manifest.id)
      throw new ApiError(409, '上传的包不属于所选扩展来源')
    await this.publish(account, {
      id: result.manifest.id,
      name: result.manifest.name,
      kind: 'package',
      version: result.manifest.version,
      digest: result.digest,
      manifest: result.manifest,
      directory: result.directory,
      config: {},
      revision: body.revision,
    })
    return {
      id: result.manifest.id,
      version: result.manifest.version,
      digest: result.digest,
    }
  }

  async skillArchive(
    account: Account,
    sourceId: string,
    version: string,
    skillId: string,
    signal: AbortSignal,
  ) {
    requirePermission(account, 'agents.manage')
    const [row] = await this.options.db.query(
      "SELECT v.manifest_json,v.installation_path FROM agent_extension_sources s JOIN agent_extension_versions v ON v.source_id=s.id WHERE s.id=$1 AND s.kind='package' AND s.enabled=1 AND v.version=$2",
      [extensionId(sourceId), extensionVersion(version)],
    )
    const manifest = json<StoredManifest>(row?.manifest_json, { tools: [] })
    const skill = manifest.skills?.find(
      (item) => item.id === extensionId(skillId),
    )
    if (!skill || !row?.installation_path)
      throw new ApiError(404, '扩展技能版本不存在或已停用')
    return installedSkillArchive(
      text(row.installation_path),
      skill.entrypoint,
      signal,
    )
  }

  async discover(account: Account, body: Row, signal: AbortSignal) {
    requirePermission(account, 'extensions.manage')
    const endpoint = requiredText(body.endpoint, 'MCP 地址', 2048)
    let token = text(body.token)
    if (body.id && body.token === undefined) {
      const [source] = await this.options.db.query(
        'SELECT configuration_json FROM agent_extension_sources WHERE id=$1',
        [extensionId(body.id)],
      )
      const configuration = json<SourceConfiguration>(
        source?.configuration_json,
        {},
      )
      if (configuration.endpoint !== endpoint)
        throw new ApiError(422, '已有 MCP 凭据只能用于原端点')
      if (configuration.encryptedToken)
        token = this.cipher.open(
          configuration.encryptedToken,
          `extension:${body.id}`,
        )
    }
    if (token.length > 8192) throw new ApiError(422, 'MCP 凭据过长')
    const tools = await withMcp(
      {
        kind: 'http',
        endpoint,
        token,
        allowedOrigins: this.options.allowedOrigins,
      },
      signal,
      (client) => discoverMcp(client, signal),
    )
    return { tools, discoveryDigest: hash(tools) }
  }

  async connect(account: Account, body: Row, signal: AbortSignal) {
    requirePermission(account, 'extensions.manage')
    const id = extensionId(body.id)
    if (id === builtinSourceId) throw new ApiError(409, '不能覆盖产品内置扩展')
    const [old] = await this.options.db.query(
      'SELECT * FROM agent_extension_sources WHERE id=$1',
      [id],
    )
    const oldConfig = json<SourceConfiguration>(old?.configuration_json, {})
    const endpoint = requiredText(body.endpoint, 'MCP 地址', 2048)
    if (old && (old.kind !== 'mcp-http' || oldConfig.endpoint !== endpoint))
      throw new ApiError(
        409,
        '变更 MCP 地址需创建新的来源，避免历史凭据发往其他服务',
      )
    const token =
      body.token === undefined
        ? oldConfig.encryptedToken
          ? this.cipher.open(oldConfig.encryptedToken, `extension:${id}`)
          : ''
        : text(body.token)
    const discovered = await this.discover(account, { endpoint, token }, signal)
    if (body.discoveryDigest !== discovered.discoveryDigest)
      throw new ApiError(409, '发现结果已变化，请重新检查并选择工具')
    if (
      !Array.isArray(body.selectedToolIds) ||
      !body.selectedToolIds.length ||
      body.selectedToolIds.some((item) => typeof item !== 'string')
    )
      throw new ApiError(422, '请选择允许使用的 MCP 工具')
    const selected = new Set(body.selectedToolIds)
    const tools = discovered.tools.filter((tool) => selected.has(tool.id))
    if (tools.length !== selected.size)
      throw new ApiError(422, '选择了未发现的 MCP 工具')
    const version = extensionVersion(body.version)
    const manifest: StoredManifest = { tools, endpoint }
    await this.publish(account, {
      id,
      name: requiredText(body.name, 'MCP 名称', 100),
      kind: 'mcp-http',
      version,
      manifest,
      digest: hash(manifest),
      config: {
        endpoint,
        encryptedToken: token
          ? this.cipher.seal(token, `extension:${id}`)
          : undefined,
      },
      revision: body.revision,
    })
    return { id, version }
  }

  private async publish(
    account: Account,
    input: {
      id: string
      name: string
      kind: string
      version: string
      digest: string
      manifest: StoredManifest
      directory?: string
      config: SourceConfiguration
      revision: unknown
    },
  ) {
    await this.options.db.transaction(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `extension:${input.id}`,
      ])
      const [old] = await db.query(
        'SELECT * FROM agent_extension_sources WHERE id=$1 FOR UPDATE',
        [input.id],
      )
      if (old && input.revision !== Number(old.revision))
        throw new ApiError(409, '扩展已被修改，请刷新后重试')
      if (old && old.kind !== input.kind)
        throw new ApiError(409, '扩展来源类型不能改变')
      const [version] = await db.query(
        'SELECT digest FROM agent_extension_versions WHERE source_id=$1 AND version=$2',
        [input.id, input.version],
      )
      if (version && version.digest !== input.digest)
        throw new ApiError(409, '同一版本不能替换内容，请提高版本号')
      const now = utcNow()
      await db.query(
        "INSERT INTO agent_extension_sources(id,name,kind,enabled,revision,active_version,status,configuration_json,installed_by,created_at,updated_at) VALUES($1,$2,$3,1,1,$4,'ready',$5,$6,$7,$7) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,enabled=1,revision=agent_extension_sources.revision+1,active_version=EXCLUDED.active_version,status='ready',configuration_json=EXCLUDED.configuration_json,diagnostic=NULL,updated_at=EXCLUDED.updated_at",
        [
          input.id,
          input.name,
          input.kind,
          input.version,
          JSON.stringify(input.config),
          account.userId,
          now,
        ],
      )
      await db.query(
        'INSERT INTO agent_extension_versions(source_id,version,digest,manifest_json,installation_path,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(source_id,version) DO NOTHING',
        [
          input.id,
          input.version,
          input.digest,
          JSON.stringify(input.manifest),
          input.directory ?? null,
          now,
        ],
      )
      await this.options.audit(
        account.userId,
        'extension.install',
        input.id,
        { version: input.version, digest: input.digest },
        db,
      )
    })
  }

  async check(
    account: Account,
    id: string,
    version: string,
    signal: AbortSignal,
  ) {
    requirePermission(account, 'extensions.manage')
    const [source] = await this.options.db.query(
      'SELECT * FROM agent_extension_sources WHERE id=$1',
      [id],
    )
    const [installed] = await this.options.db.query(
      'SELECT * FROM agent_extension_versions WHERE source_id=$1 AND version=$2',
      [id, version || source?.active_version],
    )
    if (!source || !installed) throw new ApiError(404, '扩展版本不存在')
    const manifest = json<StoredManifest>(installed.manifest_json, {
      tools: [],
    })
    const config = json<SourceConfiguration>(source.configuration_json, {})
    if (source.kind === 'mcp-http' || manifest.runtime === 'mcp-stdio') {
      const target =
        source.kind === 'mcp-http'
          ? {
              kind: 'http' as const,
              endpoint: config.endpoint!,
              token: config.encryptedToken
                ? this.cipher.open(config.encryptedToken, `extension:${id}`)
                : '',
              allowedOrigins: this.options.allowedOrigins,
            }
          : {
              kind: 'stdio' as const,
              installation: text(installed.installation_path),
              entrypoint: manifest.entrypoint!,
              workDirectory: text(installed.installation_path),
            }
      await withMcp(target, signal, async (client) => {
        const discovered = await discoverMcp(client, signal)
        for (const approved of manifest.tools) {
          const actual = discovered.find(
            (tool) =>
              tool.remoteName === approved.remoteName ||
              tool.id === approved.id,
          )
          if (
            !actual ||
            hash(actual.inputSchema) !== hash(approved.inputSchema) ||
            hash(actual.outputSchema) !== hash(approved.outputSchema)
          )
            throw new ApiError(
              409,
              `工具 ${approved.name} 的接口已变化，请重新发现并授权新版本`,
            )
        }
      })
    } else {
      const result = await runToolProcess({
        installation: text(installed.installation_path),
        entrypoint: manifest.entrypoint!,
        runtime: manifest.runtime as 'node' | 'python',
        workRoot: join(this.options.directory, '.checks'),
        input: { operation: 'health' },
        timeoutSeconds: 30,
        signal,
      })
      if (result.ok !== true) throw new ApiError(422, '扩展健康检查失败')
    }
    await this.options.audit(account.userId, 'extension.check', id, {
      version: installed.version,
    })
    return { ok: true, version: text(installed.version), checkedAt: utcNow() }
  }

  async update(
    account: Account,
    id: string,
    body: Row,
    signal = new AbortController().signal,
  ) {
    requirePermission(account, 'extensions.manage')
    if (body.enabled === true)
      await this.check(account, id, text(body.version), signal)
    await this.options.db.transaction(async (db) => {
      const [old] = await db.query(
        'SELECT * FROM agent_extension_sources WHERE id=$1 FOR UPDATE',
        [id],
      )
      if (!old) throw new ApiError(404, '扩展来源不存在')
      if (body.revision !== Number(old.revision))
        throw new ApiError(409, '扩展已被修改，请刷新后重试')
      if (typeof body.enabled !== 'boolean')
        throw new ApiError(422, '请指定启用状态')
      const version = text(body.version) || text(old.active_version)
      const [installed] = await db.query(
        'SELECT version FROM agent_extension_versions WHERE source_id=$1 AND version=$2',
        [id, version],
      )
      if (!installed) throw new ApiError(422, '只能激活已经成功安装的版本')
      await db.query(
        'UPDATE agent_extension_sources SET enabled=$2,active_version=$3,status=$4,revision=revision+1,updated_at=$5 WHERE id=$1',
        [
          id,
          body.enabled ? 1 : 0,
          version,
          body.enabled ? 'ready' : 'disabled',
          utcNow(),
        ],
      )
      await this.options.audit(
        account.userId,
        'extension.configure',
        id,
        { version, enabled: body.enabled },
        db,
      )
    })
    return { ok: true }
  }

  async bind(
    value: unknown,
    fallback?: string,
  ): Promise<BoundToolImplementation> {
    if (!value) return builtinBinding(fallback ?? '')
    const input = object(value)
    const sourceId = extensionId(input.sourceId)
    const toolId = extensionId(input.toolId)
    if (sourceId === builtinSourceId) {
      const bound = builtinBinding(
        toolId,
        text(input.version) || builtinVersion,
        text(input.digest) || undefined,
      )
      if (input.version && input.version !== bound.implementation.version)
        throw new ApiError(409, '内置工具版本不可用')
      if (input.digest && input.digest !== bound.implementation.digest)
        throw new ApiError(409, '内置工具内容已改变，请绑定新版本')
      return bound
    }
    const [source] = await this.options.db.query(
      'SELECT * FROM agent_extension_sources WHERE id=$1',
      [sourceId],
    )
    if (!source) throw new ApiError(422, '扩展不存在')
    if (source.enabled !== 1) throw new ApiError(403, '扩展已停用')
    const version = text(input.version) || text(source.active_version)
    const [row] = await this.options.db.query(
      'SELECT * FROM agent_extension_versions WHERE source_id=$1 AND version=$2',
      [sourceId, version],
    )
    const descriptor = json<StoredManifest>(row?.manifest_json, {
      tools: [],
    }).tools.find((tool) => tool.id === toolId)
    if (!row || !descriptor)
      throw new ApiError(422, '扩展工具版本未安装或未授权')
    if (input.digest && input.digest !== row.digest)
      throw new ApiError(409, '已绑定的扩展内容校验失败')
    return {
      implementation: { sourceId, version, toolId, digest: text(row.digest) },
      descriptor,
    }
  }

  async storeSecrets(
    db: SqlConnection,
    owner: string,
    id: string,
    values: Record<string, unknown>,
    version: number,
  ) {
    await db.query(
      'INSERT INTO agent_tool_secrets(owner_user_id,tool_id,encrypted_json,updated_at,version) VALUES($1,$2,$3,$4,$5)',
      [
        owner,
        id,
        this.cipher.seal(
          JSON.stringify(values),
          `tool:${owner}:${id}:${version}`,
        ),
        utcNow(),
        version,
      ],
    )
  }

  async secrets(
    owner: string,
    id: string,
    version?: number,
  ): Promise<Record<string, unknown>> {
    const [row] = await this.options.db.query(
      'SELECT encrypted_json,version FROM agent_tool_secrets WHERE owner_user_id=$1 AND tool_id=$2 AND ($3::int IS NULL OR version=$3) ORDER BY version DESC LIMIT 1',
      [owner, id, version ?? null],
    )
    return row
      ? (JSON.parse(
          this.cipher.open(
            text(row.encrypted_json),
            `tool:${owner}:${id}:${row.version}`,
          ),
        ) as Record<string, unknown>)
      : {}
  }

  async invoke(
    ref: ToolImplementationRef,
    args: Record<string, unknown>,
    configuration: Record<string, unknown>,
    signal: AbortSignal,
    context?: {
      sessionId: string
      bindingVersion: number
      sources: { reference: Record<string, unknown>; contentBase64: string }[]
    },
  ) {
    const bound = await this.bind(ref)
    validateValue(bound.descriptor.inputSchema, args, '工具参数')
    validateValue(
      bound.descriptor.configurationSchema,
      configuration,
      '工具配置',
    )
    if (ref.sourceId === builtinSourceId)
      throw new ApiError(422, '内置工具由办公适配器执行')
    const [source] = await this.options.db.query(
      'SELECT * FROM agent_extension_sources WHERE id=$1 AND enabled=1',
      [ref.sourceId],
    )
    if (!source) throw new ApiError(403, '工具来源已停用')
    const [version] = await this.options.db.query(
      'SELECT * FROM agent_extension_versions WHERE source_id=$1 AND version=$2',
      [ref.sourceId, ref.version],
    )
    if (!version || version.digest !== ref.digest)
      throw new ApiError(409, '扩展版本校验失败')
    const manifest = json<StoredManifest>(version.manifest_json, { tools: [] })
    const config = json<SourceConfiguration>(source.configuration_json, {})
    let result: unknown
    let token = ''
    if (source.kind === 'mcp-http') {
      token = config.encryptedToken
        ? this.cipher.open(config.encryptedToken, `extension:${ref.sourceId}`)
        : ''
      result = await callMcp(
        {
          kind: 'http',
          endpoint: manifest.endpoint!,
          token,
          allowedOrigins: this.options.allowedOrigins,
        },
        bound.descriptor,
        args,
        signal,
      )
    } else if (manifest.runtime === 'mcp-stdio') {
      const root = join(this.options.directory, 'work')
      await mkdir(root, { recursive: true })
      const directory = await mkdtemp(join(root, 'mcp-'))
      try {
        result = await callMcp(
          {
            kind: 'stdio',
            installation: text(version.installation_path),
            entrypoint: manifest.entrypoint!,
            workDirectory: directory,
          },
          bound.descriptor,
          args,
          signal,
        )
      } finally {
        await rm(directory, { recursive: true, force: true, maxRetries: 3 })
      }
    } else {
      result = await runToolProcess({
        installation: text(version.installation_path),
        entrypoint: manifest.entrypoint!,
        runtime: manifest.runtime === 'python' ? 'python' : 'node',
        workRoot: join(this.options.directory, 'work'),
        input: {
          operation: 'invoke',
          toolId: ref.toolId,
          arguments: args,
          configuration,
          ...(context ? { context } : {}),
        },
        timeoutSeconds: bound.descriptor.timeoutSeconds,
        signal,
      })
    }
    if (bound.descriptor.outputSchema)
      validateValue(
        bound.descriptor.outputSchema,
        object(result).structuredContent ?? result,
        '工具结果',
      )
    const properties = object(
      bound.descriptor.configurationSchema.properties ?? {},
    )
    const secrets = Object.entries(configuration)
      .filter(([key]) => object(properties[key] ?? {}).writeOnly === true)
      .map(([, value]) => String(value))
      .filter(Boolean)
    if (token) secrets.push(token)
    const payload = object(object(result).structuredContent ?? result)
    if (Array.isArray(payload.artifacts))
      for (const raw of payload.artifacts) {
        const bytes = Buffer.from(text(object(raw).contentBase64), 'base64')
        if (secrets.some((secret) => bytes.includes(Buffer.from(secret))))
          throw new ApiError(
            502,
            '扩展成果包含工具凭据，已阻止保存；请检查扩展实现',
          )
      }
    let serialized = JSON.stringify(result)
    if (serialized.length > 32 * 1024 * 1024)
      throw new ApiError(413, '工具结果超过大小限制')
    for (const secret of secrets)
      serialized = serialized.replaceAll(
        JSON.stringify(secret).slice(1, -1),
        '[已隐藏凭据]',
      )
    return JSON.parse(serialized) as Record<string, unknown>
  }
}
