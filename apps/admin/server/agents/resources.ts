import {
  ApiError,
  integer,
  object,
  requiredText,
  text,
  utcNow,
  type Account,
} from '../http/api-router.ts'
import { identifier, requirePermission } from '../conversations/store.ts'
import {
  json,
  type Row,
  type SqlConnection,
} from '../infrastructure/database.ts'
import { agentSkills, agentTools } from './contracts.ts'
import type { AgentServiceOptions } from './service.ts'
import type {
  AgentResource,
  AgentResourceCatalog,
  AgentResourceKind,
  AgentSkill,
  AgentToolConfig,
  KnowledgeBase,
} from './resource-contracts.ts'

const tables = {
  'knowledge-bases': 'business_knowledge_bases',
  skills: 'business_agent_skills',
  tools: 'business_agent_tools',
} as const
const labels = { 'knowledge-bases': '知识库', skills: '技能', tools: '工具' }
const tools = new Set<string>(agentTools.map((item) => item.id))
const defaultRequirements: Record<string, string[]> = {
  'company-knowledge': ['knowledge_search'],
  'sales-analysis': ['spreadsheet_report'],
  'business-presentation': ['presentation_report'],
}
const view = <T>(row: Row) => json<T>(row.definition_json, {} as T)

export function resourceIds(
  value: unknown,
  name: string,
  maximum = 100,
): string[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new ApiError(422, `${name}格式不正确`)
  const ids = value.map((item) => requiredText(item, name, 160))
  if (new Set(ids).size !== ids.length)
    throw new ApiError(422, `${name}不能重复`)
  return ids
}

function common(body: Row) {
  if (typeof body.enabled !== 'boolean')
    throw new ApiError(422, '启用状态必须为布尔值')
  if (typeof body.description !== 'string' || body.description.length > 1000)
    throw new ApiError(422, '说明不能超过 1000 个字符')
  return {
    name: requiredText(body.name, '名称', 100).trim(),
    description: body.description.trim(),
    enabled: body.enabled,
  }
}

function toolSettings(id: string, value: unknown): AgentToolConfig['settings'] {
  const input = object(value)
  const accepted =
    id === 'knowledge_search' ? ['maxResults'] : ['companyName', 'title']
  if (Object.keys(input).some((key) => !accepted.includes(key)))
    throw new ApiError(422, '工具包含不支持的配置项')
  if (id === 'knowledge_search')
    return input.maxResults === undefined
      ? {}
      : { maxResults: integer(input.maxResults, 8, 1, 8) }
  const output: AgentToolConfig['settings'] = {}
  for (const [key, maximum] of [
    ['companyName', 120],
    ['title', 160],
  ] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'string' || input[key].length > maximum)
        throw new ApiError(422, `${key}配置无效`)
      if (input[key].trim()) output[key] = input[key].trim()
    }
  }
  return output
}

export class AgentResourceService {
  readonly options: AgentServiceOptions
  constructor(options: AgentServiceOptions) {
    this.options = options
  }

  async ensureDefaults(account: Account): Promise<void> {
    requirePermission(account, 'agents.manage')
    await this.ensureDefaultsForOwner(account.userId)
  }

  /** Internal compatibility initialization for a verified agent resource owner. */
  async ensureDefaultsForOwner(owner: string): Promise<void> {
    await this.options.db.transaction(async (db) => {
      const key = `business-agent-resources:${owner}`
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        key,
      ])
      const [marker] = await db.query(
        'SELECT key FROM instance_settings WHERE key=$1',
        [key],
      )
      if (marker) return
      const now = utcNow()
      for (const [kind, entries] of [
        ['tools', agentTools.map((entry) => ({ ...entry, settings: {} }))],
        [
          'skills',
          agentSkills.map((entry) => ({
            ...entry,
            requiredToolIds: defaultRequirements[entry.id]!,
          })),
        ],
      ] as const) {
        for (const entry of entries) {
          const item = {
            ...entry,
            enabled: true,
            version: 1,
            createdAt: now,
            updatedAt: now,
          }
          await db.query(
            `INSERT INTO ${tables[kind]}(id,owner_user_id,name,version,enabled,definition_json,created_at,updated_at) VALUES($1,$2,$3,1,1,$4,$5,$5) ON CONFLICT(owner_user_id,id) DO NOTHING`,
            [item.id, owner, item.name, JSON.stringify(item), now],
          )
        }
      }
      await db.query(
        'INSERT INTO instance_settings(key,value,updated_at) VALUES($1,$2,$3)',
        [key, '1', now],
      )
    })
  }

  async list(
    kind: AgentResourceKind,
    account: Account,
    query: URLSearchParams,
  ) {
    requirePermission(account, 'agents.manage')
    const page = integer(query.get('page'), 1, 1, 100000)
    const pageSize = integer(query.get('pageSize'), 25, 1, 100)
    const search = (query.get('search') || '').trim().slice(0, 100)
    const values = [account.userId, `%${search.replace(/[\\%_]/g, '\\$&')}%`]
    const where = 'owner_user_id=$1 AND deleted_at IS NULL AND name ILIKE $2'
    const [count] = await this.options.db.query(
      `SELECT COUNT(*) AS total FROM ${tables[kind]} WHERE ${where}`,
      values,
    )
    const rows = await this.options.db.query(
      `SELECT definition_json FROM ${tables[kind]} WHERE ${where} ORDER BY updated_at DESC,id LIMIT $3 OFFSET $4`,
      [...values, pageSize, (page - 1) * pageSize],
    )
    return {
      items: rows.map((row) => view<AgentResource>(row)),
      total: Number(count?.total || 0),
      page,
      pageSize,
    }
  }

  async saveKnowledge(
    account: Account,
    body: Row,
    id?: string,
  ): Promise<KnowledgeBase> {
    requirePermission(account, 'agents.manage')
    const input = {
      ...common(body),
      assetIds: resourceIds(body.assetIds, '资料', 100),
    }
    return this.save(
      'knowledge-bases',
      account,
      body,
      input,
      id,
      async (db) => {
        const rows = await db.query(
          'SELECT id,kind FROM business_agent_assets WHERE owner_user_id=$1 AND id=ANY($2::text[])',
          [account.userId, input.assetIds],
        )
        if (rows.length !== input.assetIds.length)
          throw new ApiError(422, '资料不存在或不属于当前维护者')
        for (const kind of ['spreadsheet-template', 'presentation-template'])
          if (rows.filter((row) => row.kind === kind).length > 1)
            throw new ApiError(422, '同一知识库内的同类输出只能绑定一个模板')
      },
    )
  }

  async getKnowledge(account: Account, id: string): Promise<KnowledgeBase> {
    requirePermission(account, 'agents.manage')
    const [row] = await this.options.db.query(
      'SELECT definition_json FROM business_knowledge_bases WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL',
      [account.userId, id],
    )
    if (!row) throw new ApiError(404, '知识库不存在')
    return view<KnowledgeBase>(row)
  }

  async saveSkill(
    account: Account,
    body: Row,
    id?: string,
  ): Promise<AgentSkill> {
    requirePermission(account, 'agents.manage')
    const input = {
      ...common(body),
      instructions: requiredText(body.instructions, '技能执行指令', 12000),
      requiredToolIds: resourceIds(body.requiredToolIds, '依赖工具', 3),
    }
    if (input.requiredToolIds.some((tool) => !tools.has(tool)))
      throw new ApiError(422, '技能引用了未注册的工具')
    return this.save('skills', account, body, input, id, async (db) => {
      const rows = await db.query(
        'SELECT id FROM business_agent_tools WHERE owner_user_id=$1 AND id=ANY($2::text[]) AND deleted_at IS NULL',
        [account.userId, input.requiredToolIds],
      )
      if (rows.length !== input.requiredToolIds.length)
        throw new ApiError(422, '技能依赖的工具不存在')
    })
  }

  async saveTool(
    account: Account,
    body: Row,
    id: string,
  ): Promise<AgentToolConfig> {
    requirePermission(account, 'agents.manage')
    if (!tools.has(id)) throw new ApiError(404, '工具不存在')
    const input = { ...common(body), settings: toolSettings(id, body.settings) }
    return this.save('tools', account, body, input, id)
  }

  private async save<T extends AgentResource>(
    kind: AgentResourceKind,
    account: Account,
    body: Row,
    input: Omit<T, 'id' | 'version' | 'createdAt' | 'updatedAt'>,
    id?: string,
    validate?: (connection: SqlConnection) => Promise<void>,
  ): Promise<T> {
    return this.options.db.transaction(async (db) => {
      // Agent writers acquire the same owner lock before validating references.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `business-agent-references:${account.userId}`,
      ])
      const [old] = id
        ? await db.query(
            `SELECT * FROM ${tables[kind]} WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`,
            [account.userId, id],
          )
        : []
      if (id && !old) throw new ApiError(404, `${labels[kind]}不存在`)
      if (old && body.version !== Number(old.version))
        throw new ApiError(409, `${labels[kind]}已被修改，请刷新后重试`)
      await validate?.(db)
      const now = utcNow()
      const item = {
        ...input,
        id: id || identifier(kind === 'skills' ? 'skill' : 'knowledge'),
        version: old ? Number(old.version) + 1 : 1,
        createdAt: old ? text(old.created_at) : now,
        updatedAt: now,
      } as T
      await db.query(
        `INSERT INTO ${tables[kind]}(id,owner_user_id,name,version,enabled,definition_json,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(owner_user_id,id) DO UPDATE SET name=EXCLUDED.name,version=EXCLUDED.version,enabled=EXCLUDED.enabled,definition_json=EXCLUDED.definition_json,updated_at=EXCLUDED.updated_at`,
        [
          item.id,
          account.userId,
          item.name,
          item.version,
          item.enabled ? 1 : 0,
          JSON.stringify(item),
          item.createdAt,
          now,
        ],
      )
      await this.options.audit(
        account.userId,
        `agent.${kind}.${id ? 'update' : 'create'}`,
        item.id,
        { version: item.version, enabled: item.enabled },
        db,
      )
      return item
    })
  }

  async remove(
    kind: 'knowledge-bases' | 'skills',
    account: Account,
    id: string,
  ): Promise<void> {
    requirePermission(account, 'agents.manage')
    await this.options.db.transaction(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `business-agent-references:${account.userId}`,
      ])
      const [old] = await db.query(
        `SELECT id FROM ${tables[kind]} WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`,
        [account.userId, id],
      )
      if (!old) throw new ApiError(404, `${labels[kind]}不存在`)
      const field = kind === 'skills' ? 'skillIds' : 'knowledgeBaseIds'
      const [used] = await db.query(
        `SELECT id FROM business_agents WHERE owner_user_id=$1 AND deleted_at IS NULL AND (definition_json::jsonb->$3) ? $2 LIMIT 1`,
        [account.userId, id, field],
      )
      if (used)
        throw new ApiError(409, `${labels[kind]}仍被智能体引用，请先解除关联`)
      await db.query(
        `UPDATE ${tables[kind]} SET deleted_at=$3,enabled=0 WHERE owner_user_id=$1 AND id=$2`,
        [account.userId, id, utcNow()],
      )
      await this.options.audit(
        account.userId,
        `agent.${kind}.delete`,
        id,
        {},
        db,
      )
    })
  }

  async catalog(account: Account): Promise<AgentResourceCatalog> {
    requirePermission(account, 'agents.manage')
    const get = async <T>(kind: AgentResourceKind) =>
      (
        await this.options.db.query(
          `SELECT definition_json FROM ${tables[kind]} WHERE owner_user_id=$1 AND deleted_at IS NULL ORDER BY name,id`,
          [account.userId],
        )
      ).map((row) => view<T>(row))
    const [knowledgeBases, skills, configuredTools] = await Promise.all([
      get<KnowledgeBase>('knowledge-bases'),
      get<AgentSkill>('skills'),
      get<AgentToolConfig>('tools'),
    ])
    return { knowledgeBases, skills, tools: configuredTools }
  }

  async resolve(
    owner: string,
    knowledgeBaseIds: string[],
    skillIds: string[],
    toolIds: string[],
  ): Promise<AgentResourceCatalog> {
    const get = async <T>(kind: AgentResourceKind, ids: string[]) => {
      const rows = await this.options.db.query(
        `SELECT definition_json FROM ${tables[kind]} WHERE owner_user_id=$1 AND id=ANY($2::text[]) AND deleted_at IS NULL AND enabled=1`,
        [owner, ids],
      )
      if (rows.length !== new Set(ids).size)
        throw new ApiError(
          422,
          `${labels[kind]}不存在、已停用或不属于当前维护者`,
        )
      const found = new Map(
        rows.map((row) => {
          const item = view<T & AgentResource>(row)
          return [item.id, item]
        }),
      )
      return ids.map((id) => found.get(id)!)
    }
    // Resolving may use an existing transaction's single PostgreSQL connection.
    const knowledgeBases = await get<KnowledgeBase>(
      'knowledge-bases',
      knowledgeBaseIds,
    )
    const skills = await get<AgentSkill>('skills', skillIds)
    const configuredTools = await get<AgentToolConfig>('tools', toolIds)
    for (const skill of skills)
      if (skill.requiredToolIds.some((id) => !toolIds.includes(id)))
        throw new ApiError(422, `技能“${skill.name}”所需工具未全部关联`)
    return { knowledgeBases, skills, tools: configuredTools }
  }

  async assertActive(
    owner: string,
    knowledgeBaseIds: string[],
    skillIds: string[],
    toolIds: string[],
  ): Promise<void> {
    for (const [kind, ids] of [
      ['knowledge-bases', knowledgeBaseIds],
      ['skills', skillIds],
      ['tools', toolIds],
    ] as const) {
      const rows = await this.options.db.query(
        `SELECT id FROM ${tables[kind]} WHERE owner_user_id=$1 AND id=ANY($2::text[]) AND deleted_at IS NULL AND enabled=1`,
        [owner, ids],
      )
      if (rows.length !== new Set(ids).size)
        throw new ApiError(403, `${labels[kind]}已停用或删除，请重新配置智能体`)
    }
  }
}
