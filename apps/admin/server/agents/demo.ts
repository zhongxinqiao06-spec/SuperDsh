import { ApiError, type Account } from '../http/api-router.ts'
import { requirePermission } from '../conversations/store.ts'
import { json, type Row } from '../infrastructure/database.ts'
import { BusinessAgentService, assetView } from './service.ts'
import { AgentResourceService } from './resources.ts'
import { createDemoAssets } from './office/index.ts'
import type { AgentAsset, AgentDefinition } from './contracts.ts'
import type { KnowledgeBase } from './resource-contracts.ts'

interface DemoMarker {
  version?: number
  agentIds?: string[]
  assetIds?: string[]
  knowledgeBaseIds?: string[]
  agents?: AgentDefinition[]
  assets?: AgentAsset[]
}

/** First entry creates usable, persisted examples; subsequent entry only reads. */
export async function initializeAgentExamples(
  service: BusinessAgentService,
  account: Account,
) {
  requirePermission(account, 'agents.manage')
  const lease = await service.options.db.lease(
    `superdsh:agent-demo:${account.userId}`,
  )
  if (!lease) throw new ApiError(409, '示例正在准备，请稍后刷新')
  try {
    return await service.options.db.transaction(async (connection) => {
      // Catalog defaults, documents, libraries, definitions and both markers
      // belong to one transaction, including all resource audit records.
      const scoped = new BusinessAgentService({
        ...service.options,
        db: {
          ...service.options.db,
          query: connection.query,
          transaction: (operation) => operation(connection),
        },
        audit: (actor, action, target, detail) =>
          service.options.audit(actor, action, target, detail, connection),
      })
      return initialize(scoped, account)
    })
  } finally {
    await lease.release()
  }
}

async function initialize(service: BusinessAgentService, account: Account) {
  const resources = new AgentResourceService(service.options)
  await resources.ensureDefaults(account)
  const key = `business-agent-demo:${account.userId}`
  const [previous] = await service.options.db.query(
    'SELECT value FROM instance_settings WHERE key=$1',
    [key],
  )
  const old = previous ? json<DemoMarker>(previous.value, {}) : null
  if (old?.version === 2) return currentExamples(service, account, old)

  // A legacy completion marker remains authoritative: edited or deleted
  // examples are never recreated. Only the missing resource organization is added.
  const assets = old
    ? await existingAssets(
        service,
        account,
        old.assets?.map((item) => item.id) || [],
      )
    : await createAssets(service, account)
  const libraries: KnowledgeBase[] = []
  const sourceIds =
    old?.assets?.map((item) => item.id) || assets.map((item) => item.id)
  const present = new Set(assets.map((item) => item.id))
  for (const input of [
    {
      name: '星河商贸 · 公司资料',
      description: '脱敏示例：虚构企业介绍、产品和制度。',
      indices: [1],
    },
    {
      name: '星河商贸 · 经营销售',
      description: '脱敏销售台账和可编辑 Excel 模板，可替换为公司自己的资料。',
      indices: [0, 2],
    },
    {
      name: '星河商贸 · 企业汇报',
      description: '脱敏销售台账和企业 PPT 品牌模板，用于经营汇报。',
      indices: [0, 3],
    },
  ]) {
    libraries.push(
      await resources.saveKnowledge(account, {
        name: input.name,
        description: input.description,
        enabled: true,
        assetIds: input.indices
          .map((index) => sourceIds[index])
          .filter((id): id is string => !!id && present.has(id)),
      }),
    )
  }
  const associations = [
    [libraries[0]!.id, libraries[1]!.id],
    [libraries[0]!.id, libraries[2]!.id],
    [libraries[0]!.id],
  ]
  const agents = old
    ? await upgradeLegacyAgents(
        service,
        account,
        old.agents || [],
        associations,
      )
    : await createAgents(service, account, associations)
  const marker: DemoMarker = {
    version: 2,
    agentIds:
      old?.agents?.map((item) => item.id) || agents.map((item) => item.id),
    assetIds: sourceIds,
    knowledgeBaseIds: libraries.map((item) => item.id),
  }
  await service.options.db.query(
    'INSERT INTO instance_settings(key,value,updated_at) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at',
    [key, JSON.stringify(marker), new Date().toISOString()],
  )
  return currentExamples(service, account, marker)
}

async function existingAssets(
  service: BusinessAgentService,
  account: Account,
  ids: string[],
) {
  const rows = await service.options.db.query(
    'SELECT * FROM business_agent_assets WHERE owner_user_id=$1 AND id=ANY($2::text[])',
    [account.userId, ids],
  )
  const byId = new Map(rows.map((row) => [String(row.id), assetView(row)]))
  return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
}

async function currentExamples(
  service: BusinessAgentService,
  account: Account,
  marker: DemoMarker,
) {
  const rows = await service.options.db.query(
    'SELECT definition_json FROM business_agents WHERE owner_user_id=$1 AND id=ANY($2::text[]) AND deleted_at IS NULL',
    [account.userId, marker.agentIds || []],
  )
  const byId = new Map(
    rows.map((row) => {
      const value = json<AgentDefinition>(
        row.definition_json,
        {} as AgentDefinition,
      )
      return [value.id, value]
    }),
  )
  const catalog = await new AgentResourceService(service.options).catalog(
    account,
  )
  return {
    agents: (marker.agentIds || []).flatMap((id) =>
      byId.has(id) ? [byId.get(id)!] : [],
    ),
    assets: await existingAssets(service, account, marker.assetIds || []),
    knowledgeBases: catalog.knowledgeBases.filter((item) =>
      marker.knowledgeBaseIds?.includes(item.id),
    ),
  }
}

async function createAssets(service: BusinessAgentService, account: Account) {
  const inputs = await createDemoAssets()
  const assets: AgentAsset[] = []
  for (const [input, kind] of [
    [inputs.sales, 'knowledge'],
    [inputs.knowledge, 'knowledge'],
    [inputs.workbookTemplate, 'spreadsheet-template'],
    [inputs.presentationTemplate, 'presentation-template'],
  ] as const) {
    assets.push(
      await service.upload(account, {
        name: input.filename,
        kind,
        contentBase64: input.content.toString('base64'),
      }),
    )
  }
  return assets
}

async function createAgents(
  service: BusinessAgentService,
  account: Account,
  associations: string[][],
) {
  const agents: AgentDefinition[] = []
  for (const [index, input] of [
    {
      name: '经营分析助手',
      description:
        '使用星河商贸虚构销售台账，按公司模板生成可编辑 Excel。可换成你的 CSV/XLSX。',
      instructions:
        '先核对销售数据，生成经营分析Excel，概述地区、产品收入与毛利。默认公司名称为星河商贸（虚构演示）。',
      skillIds: ['sales-analysis'],
      toolIds: ['knowledge_search', 'spreadsheet_report'],
    },
    {
      name: '企业汇报 PPT 助手',
      description: '使用公司资料、真实输入台账和品牌模板生成可编辑 PPT。',
      instructions:
        '按星河商贸（虚构演示）公司模板生成经营汇报PPT。先查询公司介绍，再根据销售数据生成文件，说明数据来源并给出定性建议。',
      skillIds: ['company-knowledge', 'business-presentation'],
      toolIds: ['knowledge_search', 'presentation_report'],
    },
    {
      name: '企业资料助手',
      description:
        '查询已绑定公司资料，回答附文件和段落来源，没有依据时明确说明。',
      instructions:
        '根据已发布公司资料回答问题。必须先检索并引用文件与段落；不得编造业务制度。',
      skillIds: ['company-knowledge'],
      toolIds: ['knowledge_search'],
    },
  ].entries()) {
    agents.push(
      await service.save(account, {
        ...input,
        knowledgeBaseIds: associations[index]!,
        knowledgeAssetIds: [],
        templateAssetIds: [],
        published: true,
      }),
    )
  }
  return agents
}

async function upgradeLegacyAgents(
  service: BusinessAgentService,
  account: Account,
  originals: AgentDefinition[],
  associations: string[][],
) {
  const agents: AgentDefinition[] = []
  for (const [index, original] of originals.entries()) {
    const [row] = await service.options.db.query(
      'SELECT definition_json FROM business_agents WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE',
      [account.userId, original.id],
    )
    if (!row) continue
    const current = json<AgentDefinition & Row>(
      row.definition_json,
      {} as AgentDefinition & Row,
    )
    if (
      Object.hasOwn(current, 'knowledgeBaseIds') ||
      JSON.stringify(current.knowledgeAssetIds) !==
        JSON.stringify(original.knowledgeAssetIds) ||
      JSON.stringify(current.templateAssetIds) !==
        JSON.stringify(original.templateAssetIds)
    ) {
      agents.push(current)
      continue
    }
    // A maintainer may have disabled a tool/skill since the old demo was
    // created. Organize its files without re-enabling it or blocking all four
    // management pages on an optional association upgrade.
    try {
      await new AgentResourceService(service.options).resolve(
        account.userId,
        associations[index] || [],
        current.skillIds,
        current.toolIds,
      )
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 422) throw error
      agents.push(current)
      continue
    }
    agents.push(
      await service.save(
        account,
        {
          ...current,
          knowledgeBaseIds: associations[index] || [],
        },
        original.id,
      ),
    )
  }
  return agents
}
