import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import {
  ApiError,
  integer,
  requiredText,
  text,
  utcNow,
  type Account,
} from '../http/api-router.ts'
import { identifier, requirePermission } from '../conversations/store.ts'
import {
  json,
  type Database,
  type Row,
  type SqlConnection,
} from '../infrastructure/database.ts'
import type { ConnectorHub } from '../devices/connector-hub.ts'
import type { FileService } from '../files/service.ts'
import { agentInput, decodedAsset } from './validation.ts'
import {
  type AgentAsset,
  type AgentBinding,
  type AgentDefinition,
} from './contracts.ts'
import { extractKnowledgeText, validateOfficeTemplate } from './office/index.ts'
import { AgentResourceService } from './resources.ts'
import { resolveAgentAssets } from './composition.ts'
import type { QdrantKnowledgeIndex } from './knowledge-index.ts'
import { renderOfficeAssetPreview } from './office/preview.ts'

export interface AgentServiceOptions {
  db: Database
  hub: ConnectorHub
  files: FileService
  knowledgeIndex?: QdrantKnowledgeIndex
  renderOfficePreview?: typeof renderOfficeAssetPreview
  getAccount(id: string): Promise<Account>
  audit(
    actor: string,
    action: string,
    target: string,
    detail?: Record<string, unknown>,
    connection?: SqlConnection,
  ): Promise<void>
}

const definition = (row: Row): AgentDefinition => {
  const value = json<AgentDefinition>(
    row.definition_json,
    {} as AgentDefinition,
  )
  return { ...value, knowledgeBaseIds: value.knowledgeBaseIds ?? [] }
}
export const assetView = (row: Row): AgentAsset => ({
  id: text(row.id),
  name: text(row.name),
  kind: row.kind as AgentAsset['kind'],
  size: Number(row.size),
  mediaType: text(row.media_type),
  sha256: text(row.sha256),
  preview: text(row.extracted_text).slice(0, 1200),
  createdAt: text(row.created_at),
})

export class BusinessAgentService {
  readonly options: AgentServiceOptions
  constructor(options: AgentServiceOptions) {
    this.options = options
  }

  async list(account: Account, query: URLSearchParams, management = false) {
    requirePermission(account, management ? 'agents.manage' : 'sessions.run')
    const page = integer(query.get('page'), 1, 1, 100000)
    const pageSize = integer(
      query.get('pageSize'),
      management ? 12 : 100,
      1,
      100,
    )
    const search = (query.get('search') || '').trim().slice(0, 100)
    const filter = management ? 'owner_user_id=$2' : 'published=1'
    const args = [`%${search.replace(/[\\%_]/g, '\\$&')}%`]
    if (management) args.push(account.userId)
    const where = `deleted_at IS NULL AND ${filter} AND name ILIKE $1`
    const [count] = await this.options.db.query(
      `SELECT COUNT(*) AS total FROM business_agents WHERE ${where}`,
      args,
    )
    const rows = await this.options.db.query(
      `SELECT * FROM business_agents WHERE ${where} ORDER BY updated_at DESC,id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
      [...args, pageSize, (page - 1) * pageSize],
    )
    return {
      items: rows.map(definition),
      total: Number(count?.total || 0),
      page,
      pageSize,
    }
  }

  async available(account: Account, id: string): Promise<AgentDefinition> {
    requirePermission(account, 'sessions.run')
    const [row] = await this.options.db.query(
      'SELECT * FROM business_agents WHERE id=$1 AND deleted_at IS NULL AND published=1',
      [id],
    )
    if (!row) throw new ApiError(404, '智能体不存在、未发布或已停用')
    return definition(row)
  }

  async save(
    account: Account,
    body: Row,
    id?: string,
  ): Promise<AgentDefinition> {
    requirePermission(account, 'agents.manage')
    const input = agentInput(body)
    const resources = new AgentResourceService(this.options)
    await resources.ensureDefaults(account)
    const result = await this.options.db.transaction(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `business-agent-references:${account.userId}`,
      ])
      const scopedDb = {
        ...this.options.db,
        query: db.query,
        transaction: <T>(
          operation: (connection: SqlConnection) => Promise<T>,
        ) => operation(db),
      }
      const resolved = await new AgentResourceService({
        ...this.options,
        db: scopedDb,
      }).resolve(
        account.userId,
        input.knowledgeBaseIds,
        input.skillIds,
        input.toolIds,
      )
      await resolveAgentAssets(
        scopedDb,
        account.userId,
        input,
        resolved.knowledgeBases,
      )
      const [old] = id
        ? await db.query(
            'SELECT * FROM business_agents WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL FOR UPDATE',
            [id, account.userId],
          )
        : []
      if (id && !old) throw new ApiError(404, '智能体不存在')
      if (old && body.version !== Number(old.version))
        throw new ApiError(409, '智能体已被修改，请刷新后重试')
      const now = utcNow()
      const agent: AgentDefinition = {
        ...input,
        id: id || identifier('agent'),
        version: old ? Number(old.version) + 1 : 1,
        createdAt: old ? text(old.created_at) : now,
        updatedAt: now,
      }
      await db.query(
        `INSERT INTO business_agents(id,owner_user_id,name,version,published,definition_json,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,version=EXCLUDED.version,published=EXCLUDED.published,definition_json=EXCLUDED.definition_json,updated_at=EXCLUDED.updated_at`,
        [
          agent.id,
          account.userId,
          agent.name,
          agent.version,
          agent.published ? 1 : 0,
          JSON.stringify(agent),
          agent.createdAt,
          now,
        ],
      )
      return agent
    })
    await this.options.audit(
      account.userId,
      id ? 'agent.update' : 'agent.create',
      result.id,
      { version: result.version, published: result.published },
    )
    return result
  }

  async remove(account: Account, id: string) {
    requirePermission(account, 'agents.manage')
    const rows = await this.options.db.query(
      'UPDATE business_agents SET deleted_at=$3,published=0 WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL RETURNING id',
      [id, account.userId, utcNow()],
    )
    if (!rows.length) throw new ApiError(404, '智能体不存在')
    await this.options.audit(account.userId, 'agent.delete', id)
  }

  async catalog(account: Account) {
    requirePermission(account, 'agents.manage')
    const resources = new AgentResourceService(this.options)
    await resources.ensureDefaults(account)
    const rows = await this.options.db.query(
      'SELECT id,name,kind,size,media_type,sha256,LEFT(extracted_text,1200) AS extracted_text,created_at FROM business_agent_assets WHERE owner_user_id=$1 ORDER BY created_at DESC,id',
      [account.userId],
    )
    return {
      ...(await resources.catalog(account)),
      assets: rows.map(assetView),
    }
  }

  async upload(account: Account, body: Row): Promise<AgentAsset> {
    requirePermission(account, 'agents.manage')
    const name = requiredText(body.name, '文件名', 150)
    if (/[\\/\x00-\x1f]/.test(name))
      throw new ApiError(422, '文件名不能包含路径')
    const kind = text(body.kind)
    const content = decodedAsset(body.contentBase64)
    const extension = extname(name).toLowerCase()
    const input = { filename: name, content }
    let extracted = '',
      mediaType = 'text/plain; charset=utf-8'
    try {
      if (kind === 'knowledge') {
        if (!['.txt', '.md', '.csv', '.xlsx', '.docx'].includes(extension))
          throw new Error('知识资料支持 TXT、Markdown、CSV、XLSX、DOCX')
        extracted = (await extractKnowledgeText(input)).text
      } else if (kind === 'spreadsheet-template' && extension === '.xlsx') {
        await validateOfficeTemplate(input, 'xlsx')
      } else if (kind === 'presentation-template' && extension === '.pptx') {
        await validateOfficeTemplate(input, 'pptx')
      } else throw new Error('请选择与文件匹配的资料或模板类型')
    } catch (error) {
      throw new ApiError(
        422,
        error instanceof Error ? error.message : '文件解析失败',
      )
    }
    if (extension === '.xlsx')
      mediaType =
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    if (extension === '.pptx')
      mediaType =
        'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    if (extension === '.docx')
      mediaType =
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    if (extension === '.csv') mediaType = 'text/csv; charset=utf-8'
    const hash = createHash('sha256').update(content).digest('hex')
    const id = identifier('asset')
    const [row] = await this.options.db.query(
      `INSERT INTO business_agent_assets(id,owner_user_id,name,kind,size,media_type,sha256,content,extracted_text,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(owner_user_id,kind,name,sha256) DO UPDATE SET name=EXCLUDED.name RETURNING *`,
      [
        id,
        account.userId,
        name,
        kind,
        content.length,
        mediaType,
        hash,
        content,
        extracted,
        utcNow(),
      ],
    )
    await this.options.audit(
      account.userId,
      'agent.asset.upload',
      text(row!.id),
      { kind, name, size: content.length },
    )
    return assetView(row!)
  }

  private async assetRow(account: Account, id: string) {
    requirePermission(account, 'agents.manage')
    const [row] = await this.options.db.query(
      'SELECT * FROM business_agent_assets WHERE id=$1 AND owner_user_id=$2',
      [id, account.userId],
    )
    if (!row) throw new ApiError(404, '资料不存在')
    return row
  }

  async previewAsset(account: Account, id: string, signal?: AbortSignal) {
    const row = await this.assetRow(account, id)
    return (this.options.renderOfficePreview ?? renderOfficeAssetPreview)(
      { filename: text(row.name), content: row.content as Buffer },
      signal,
    )
  }

  async asset(account: Account, id: string) {
    const row = await this.assetRow(account, id)
    return {
      ...assetView(row),
      contentBase64: (row.content as Buffer).toString('base64'),
    }
  }

  async bind(
    account: Account,
    session: Row,
    selected: AgentDefinition,
  ): Promise<void> {
    if (session.executor_kind !== 'server-agent')
      throw new ApiError(422, '业务智能体需要使用服务端 Agent')
    const [agentRow] = await this.options.db.query(
      'SELECT owner_user_id FROM business_agents WHERE id=$1 AND deleted_at IS NULL AND published=1',
      [selected.id],
    )
    if (!agentRow) throw new ApiError(404, '智能体已不可用')
    const resourceOwnerId = text(agentRow.owner_user_id)
    const resources = new AgentResourceService(this.options)
    // Legacy agents gain editable defaults without changing their identities.
    await resources.ensureDefaultsForOwner(resourceOwnerId)
    const resolved = await resources.resolve(
      resourceOwnerId,
      selected.knowledgeBaseIds ?? [],
      selected.skillIds,
      selected.toolIds,
    )
    const composed = await resolveAgentAssets(
      this.options.db,
      resourceOwnerId,
      selected,
      resolved.knowledgeBases,
    )
    const binding: AgentBinding = {
      sessionId: text(session.id),
      presetId: `business-${createHash('sha256').update(text(session.id)).digest('hex').slice(0, 32)}`,
      definition: {
        ...selected,
        knowledgeBaseIds: selected.knowledgeBaseIds ?? [],
        knowledgeAssetIds: composed.knowledgeAssetIds,
        templateAssetIds: composed.templateAssetIds,
      },
      assets: composed.assets.map(assetView),
      resourceOwnerId,
      ...resolved,
    }
    await this.options.db.transaction(async (db) => {
      await db.query(
        'INSERT INTO business_agent_sessions(session_id,owner_user_id,agent_id,binding_json,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [
          session.id,
          account.userId,
          selected.id,
          JSON.stringify(binding),
          utcNow(),
        ],
      )
      await db.query(
        'UPDATE sessions SET agent_definition_json=$2 WHERE id=$1',
        [
          session.id,
          JSON.stringify({
            id: selected.id,
            name: selected.name,
            version: selected.version,
          }),
        ],
      )
    })
  }

  async bindings(owner: string): Promise<AgentBinding[]> {
    const rows = await this.options.db.query(
      'SELECT binding_json FROM business_agent_sessions WHERE owner_user_id=$1',
      [owner],
    )
    return rows.map((row) =>
      json<AgentBinding>(row.binding_json, {} as AgentBinding),
    )
  }

  async binding(
    owner: string,
    sessionId: string,
  ): Promise<AgentBinding | null> {
    await this.options.hub.store.session(sessionId, owner)
    const [row] = await this.options.db.query(
      'SELECT binding_json FROM business_agent_sessions WHERE session_id=$1 AND owner_user_id=$2',
      [sessionId, owner],
    )
    return row ? json<AgentBinding>(row.binding_json, {} as AgentBinding) : null
  }

  async artifacts(account: Account, sessionId: string) {
    requirePermission(account, 'files.read')
    const binding = await this.binding(account.userId, sessionId)
    const rows = await this.options.db.query(
      'SELECT metadata_json FROM business_agent_artifacts WHERE session_id=$1 ORDER BY created_at,id',
      [sessionId],
    )
    return {
      items: rows.map((row) => json<Row>(row.metadata_json, {})),
      agentDefinition: binding
        ? {
            id: binding.definition.id,
            name: binding.definition.name,
            version: binding.definition.version,
          }
        : null,
    }
  }
}
