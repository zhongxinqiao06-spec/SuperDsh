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
import { agentSkills, agentTools, defaultSkillTools } from './contracts.ts'
import { presentationSkillIds } from './presentation-skills.ts'
import { builtinBinding } from '../extensions/service.ts'
import { validateValue } from '../extensions/validation.ts'
import { packagePath } from '../extensions/validation.ts'
import { validateSkillProgram } from '../skills/definitions.ts'
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
      const upgradeKey = `${key}:document-v1`
      const [upgraded] = await db.query(
        'SELECT key FROM instance_settings WHERE key=$1',
        [upgradeKey],
      )
      const graphicKey = `${key}:illustration-v1`
      const [graphic] = await db.query(
        'SELECT key FROM instance_settings WHERE key=$1',
        [graphicKey],
      )
      const presentationKey = `${key}:presentation-skills-v1`
      const [presentation] = await db.query(
        'SELECT key FROM instance_settings WHERE key=$1',
        [presentationKey],
      )
      const flowKey = `${key}:skill-flows-v1`
      const [flows] = await db.query(
        'SELECT key FROM instance_settings WHERE key=$1',
        [flowKey],
      )
      const multimodalKey = `${key}:multimodal-tools-v1`
      const [multimodal] = await db.query(
        'SELECT key FROM instance_settings WHERE key=$1',
        [multimodalKey],
      )
      if (marker && upgraded && graphic && presentation && flows && multimodal)
        return
      const now = utcNow()
      for (const [kind, entries] of [
        ['tools', agentTools.map((entry) => ({ ...entry, settings: {} }))],
        [
          'skills',
          agentSkills.map((entry) => ({
            ...entry,
            requiredToolIds: defaultSkillTools[entry.id]!,
          })),
        ],
      ] as const) {
        for (const entry of entries) {
          if (
            marker &&
            !(
              !upgraded &&
              ['document_report', 'business-document'].includes(entry.id)
            ) &&
            !(!graphic && entry.id === 'illustration_render') &&
            !(
              !multimodal &&
              ['image_generate', 'vision_analyze'].includes(entry.id)
            ) &&
            !(
              !flows &&
              ['presentation-flow', 'document-flow'].includes(entry.id)
            ) &&
            !(
              !presentation &&
              presentationSkillIds.some((id) => id === entry.id)
            )
          )
            continue
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
        'INSERT INTO instance_settings(key,value,updated_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [marker ? upgradeKey : key, '1', now],
      )
      if (!marker)
        await db.query(
          'INSERT INTO instance_settings(key,value,updated_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [upgradeKey, '1', now],
        )
      await db.query(
        'INSERT INTO instance_settings(key,value,updated_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [graphicKey, '1', now],
      )
      await db.query(
        'INSERT INTO instance_settings(key,value,updated_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [presentationKey, '1', now],
      )
      await db.query(
        'INSERT INTO instance_settings(key,value,updated_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [flowKey, '1', now],
      )
      await db.query(
        'INSERT INTO instance_settings(key,value,updated_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [multimodalKey, '1', now],
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
    const pageSize = integer(query.get('pageSize'), 10, 1, 100)
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
        for (const kind of [
          'spreadsheet-template',
          'presentation-template',
          'document-template',
        ])
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
    if (id) {
      const [existing] = await this.options.db.query(
        'SELECT definition_json FROM business_agent_skills WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL',
        [account.userId, id],
      )
      if (!existing) throw new ApiError(404, '技能不存在')
      // A text-only edit must retain the imported reference package.
      body = { ...view<AgentSkill>(existing), ...body }
    }
    const input = {
      ...common(body),
      instructions: requiredText(body.instructions, '技能执行指令', 12000),
      requiredToolIds: resourceIds(body.requiredToolIds, '依赖工具', 100),
      ...(body.program ? { program: validateSkillProgram(body.program) } : {}),
      ...(body.programDraft !== undefined
        ? {
            programDraft:
              body.programDraft === null
                ? null
                : validateSkillProgram(body.programDraft),
          }
        : {}),
      ...(body.references !== undefined
        ? {
            references: (() => {
              if (
                !Array.isArray(body.references) ||
                body.references.length > 100
              )
                throw new ApiError(422, '技能参考文件格式错误')
              return body.references.map((raw) => {
                const entry = object(raw)
                return {
                  path: packagePath(entry.path),
                  assetId: requiredText(entry.assetId, '参考资料', 160),
                  sha256: requiredText(entry.sha256, '资料哈希', 64),
                }
              })
            })(),
          }
        : {}),
      ...(body.packageSha256
        ? { packageSha256: requiredText(body.packageSha256, '技能包哈希', 64) }
        : {}),
    }
    return this.save('skills', account, body, input, id, async (db) => {
      const rows = await db.query(
        'SELECT id FROM business_agent_tools WHERE owner_user_id=$1 AND id=ANY($2::text[]) AND deleted_at IS NULL',
        [account.userId, input.requiredToolIds],
      )
      if (rows.length !== input.requiredToolIds.length)
        throw new ApiError(422, '技能依赖的工具不存在')
      for (const reference of input.references ?? []) {
        const [asset] = await db.query(
          'SELECT id FROM business_agent_assets WHERE id=$1 AND owner_user_id=$2 AND sha256=$3',
          [reference.assetId, account.userId, reference.sha256],
        )
        if (!asset) throw new ApiError(422, '技能参考资料不存在或版本不匹配')
      }
      for (const program of [input.program, input.programDraft]) {
        if (!program) continue
        for (const stage of program.stages) {
          if (
            [...stage.toolIds, ...(stage.inspectToolIds ?? [])].some(
              (tool) => !input.requiredToolIds.includes(tool),
            )
          )
            throw new ApiError(422, `阶段“${stage.name}”的工具必须加入技能依赖`)
          if (!stage.skillId) continue
          if (stage.skillId === id)
            throw new ApiError(422, '技能不能循环引用自己')
          const [linked] = await db.query(
            'SELECT definition_json FROM business_agent_skills WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL AND enabled=1',
            [account.userId, stage.skillId],
          )
          if (!linked) throw new ApiError(422, '引用技能不存在或已停用')
          const helper = view<AgentSkill>(linked)
          if (helper.program || helper.programDraft)
            throw new ApiError(
              422,
              '阶段只能引用单项方法技能，不能嵌套执行组合',
            )
          if (
            helper.requiredToolIds.some(
              (tool) => !input.requiredToolIds.includes(tool),
            )
          )
            throw new ApiError(422, '引用技能依赖的工具未全部关联')
        }
      }
    })
  }

  async publishSkill(account: Account, id: string, version: number) {
    requirePermission(account, 'agents.manage')
    const [row] = await this.options.db.query(
      'SELECT definition_json FROM business_agent_skills WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL',
      [account.userId, id],
    )
    if (!row) throw new ApiError(404, '技能不存在')
    const skill = view<AgentSkill>(row)
    if (!skill.programDraft) throw new ApiError(422, '没有待发布的阶段配置')
    return this.saveSkill(
      account,
      { ...skill, version, program: skill.programDraft, programDraft: null },
      id,
    )
  }

  async saveTool(
    account: Account,
    body: Row,
    id?: string,
  ): Promise<AgentToolConfig> {
    requirePermission(account, 'agents.manage')
    if (id) {
      const [existing] = await this.options.db.query(
        'SELECT id FROM business_agent_tools WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL',
        [account.userId, id],
      )
      if (!existing) throw new ApiError(404, '工具不存在')
    }
    const registry = this.options.extensions
    const bound = registry
      ? await registry.bind(body.implementation, id)
      : builtinBinding(id ?? '')
    const settings = { ...object(body.settings ?? {}) }
    const secrets =
      id && registry ? await registry.secrets(account.userId, id) : {}
    const properties = object(
      bound.descriptor.configurationSchema.properties ?? {},
    )
    for (const [key, property] of Object.entries(properties)) {
      if (object(property).writeOnly !== true) continue
      if (settings[key] !== undefined) {
        if (settings[key] === '') delete secrets[key]
        else secrets[key] = settings[key]
        delete settings[key]
      }
    }
    validateValue(
      bound.descriptor.configurationSchema,
      { ...settings, ...secrets },
      '工具配置',
    )
    const input = {
      ...common(body),
      ...bound,
      settings,
      configuredSecrets: Object.keys(secrets),
    }
    if (Object.keys(secrets).length && !registry)
      throw new ApiError(503, '工具凭据存储不可用')
    return this.save(
      'tools',
      account,
      body,
      input,
      id,
      undefined,
      async (db, item) => {
        if (registry)
          await registry.storeSecrets(
            db,
            account.userId,
            item.id,
            secrets,
            item.version,
          )
      },
    )
  }

  private async save<T extends AgentResource>(
    kind: AgentResourceKind,
    account: Account,
    body: Row,
    input: Omit<T, 'id' | 'version' | 'createdAt' | 'updatedAt'>,
    id?: string,
    validate?: (connection: SqlConnection) => Promise<void>,
    afterSave?: (connection: SqlConnection, item: T) => Promise<void>,
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
        id:
          id ||
          identifier(
            kind === 'tools'
              ? 'tool'
              : kind === 'skills'
                ? 'skill'
                : 'knowledge',
          ),
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
      await db.query(
        'INSERT INTO agent_resource_versions(owner_user_id,kind,resource_id,version,definition_json,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
        [
          account.userId,
          kind,
          item.id,
          item.version,
          JSON.stringify(item),
          now,
        ],
      )
      if (old)
        await db.query(
          'INSERT INTO agent_resource_versions(owner_user_id,kind,resource_id,version,definition_json,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
          [
            account.userId,
            kind,
            item.id,
            Number(old.version),
            text(old.definition_json),
            text(old.updated_at),
          ],
        )
      await afterSave?.(db, item)
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

  async history(
    kind: AgentResourceKind,
    account: Account,
    id: string,
    query: URLSearchParams,
  ) {
    requirePermission(account, 'agents.manage')
    const [current] = await this.options.db.query(
      `SELECT definition_json FROM ${tables[kind]} WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL`,
      [account.userId, id],
    )
    if (!current) throw new ApiError(404, `${labels[kind]}不存在`)
    const page = integer(query.get('page'), 1, 1, 100000)
    const pageSize = integer(query.get('pageSize'), 10, 1, 50)
    const latest = view<AgentResource>(current)
    const [count] = await this.options.db.query(
      'SELECT COUNT(*) AS total FROM agent_resource_versions WHERE owner_user_id=$1 AND kind=$2 AND resource_id=$3 AND version<>$4',
      [account.userId, kind, id, latest.version],
    )
    const rows = await this.options.db.query(
      'SELECT version,definition_json FROM (SELECT version,definition_json FROM agent_resource_versions WHERE owner_user_id=$1 AND kind=$2 AND resource_id=$3 AND version<>$4 UNION ALL SELECT $4::integer,$5::text) AS versions ORDER BY version DESC LIMIT $6 OFFSET $7',
      [
        account.userId,
        kind,
        id,
        latest.version,
        JSON.stringify(latest),
        pageSize,
        (page - 1) * pageSize,
      ],
    )
    return {
      items: rows.map((row) => view<AgentResource>(row)),
      total: Number(count?.total ?? 0) + 1,
      page,
      pageSize,
      currentVersion: latest.version,
    }
  }

  async restore(
    kind: AgentResourceKind,
    account: Account,
    id: string,
    body: Row,
  ) {
    requirePermission(account, 'agents.manage')
    const [row] = await this.options.db.query(
      'SELECT definition_json FROM agent_resource_versions WHERE owner_user_id=$1 AND kind=$2 AND resource_id=$3 AND version=$4',
      [account.userId, kind, id, integer(body.sourceVersion, 0, 1, 1000000)],
    )
    if (!row) throw new ApiError(404, '资源版本不存在')
    const previous = view<AgentResource & Row>(row)
    const input: Row = { ...previous, version: body.version }
    if (kind === 'tools') {
      const registry = this.options.extensions
      const secrets = registry
        ? await registry.secrets(account.userId, id, previous.version)
        : {}
      const currentSecrets = registry
        ? await registry.secrets(account.userId, id)
        : {}
      input.settings = {
        ...object(previous.settings),
        ...Object.fromEntries(
          Object.keys(currentSecrets).map((key) => [key, '']),
        ),
        ...secrets,
      }
      return this.saveTool(account, input, id)
    }
    if (kind === 'skills') return this.saveSkill(account, input, id)
    return this.saveKnowledge(account, input, id)
  }

  async remove(
    kind: AgentResourceKind,
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
      const field =
        kind === 'tools'
          ? 'toolIds'
          : kind === 'skills'
            ? 'skillIds'
            : 'knowledgeBaseIds'
      const [used] = await db.query(
        `SELECT id FROM business_agents WHERE owner_user_id=$1 AND deleted_at IS NULL AND (definition_json::jsonb->$3) ? $2 LIMIT 1`,
        [account.userId, id, field],
      )
      if (used)
        throw new ApiError(409, `${labels[kind]}仍被智能体引用，请先解除关联`)
      if (kind === 'tools') {
        const [skill] = await db.query(
          "SELECT id FROM business_agent_skills WHERE owner_user_id=$1 AND deleted_at IS NULL AND (definition_json::jsonb->'requiredToolIds') ? $2 LIMIT 1",
          [account.userId, id],
        )
        if (skill) throw new ApiError(409, '工具仍被技能引用，请先解除关联')
      }
      if (kind === 'skills') {
        const rows = await db.query(
          'SELECT definition_json FROM business_agent_skills WHERE owner_user_id=$1 AND deleted_at IS NULL',
          [account.userId],
        )
        if (
          rows.some((row) =>
            [
              view<AgentSkill>(row).program,
              view<AgentSkill>(row).programDraft,
            ].some((program) =>
              program?.stages.some((stage) => stage.skillId === id),
            ),
          )
        )
          throw new ApiError(409, '技能仍被执行组合引用，请先解除关联')
      }
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
    const selectedSkills = await get<AgentSkill>('skills', skillIds)
    const helperIds = [
      ...new Set(
        selectedSkills.flatMap(
          (skill) =>
            skill.program?.stages.flatMap((stage) =>
              stage.skillId ? [stage.skillId] : [],
            ) ?? [],
        ),
      ),
    ].filter((id) => !skillIds.includes(id))
    const helpers = helperIds.length
      ? await get<AgentSkill>('skills', helperIds)
      : []
    if (
      [...selectedSkills, ...helpers].some(
        (skill) =>
          helperIds.includes(skill.id) && (skill.program || skill.programDraft),
      ) ||
      selectedSkills.some((skill) =>
        skill.program?.stages.some((stage) =>
          selectedSkills.some(
            (candidate) =>
              candidate.id === stage.skillId &&
              (candidate.program || candidate.programDraft),
          ),
        ),
      )
    )
      throw new ApiError(422, '不允许嵌套执行组合')
    const skills = [...selectedSkills, ...helpers]
    const configuredTools = await get<AgentToolConfig>('tools', toolIds)
    for (const tool of configuredTools) {
      const bound = this.options.extensions
        ? await this.options.extensions.bind(tool.implementation, tool.id)
        : builtinBinding(tool.id)
      Object.assign(tool, bound)
      const secrets = this.options.extensions
        ? await this.options.extensions.secrets(owner, tool.id, tool.version)
        : {}
      validateValue(
        bound.descriptor.configurationSchema,
        { ...tool.settings, ...secrets },
        `工具“${tool.name}”配置`,
      )
    }
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
