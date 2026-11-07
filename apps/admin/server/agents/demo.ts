import { ApiError, type Account } from '../http/api-router.ts'
import { requirePermission } from '../conversations/store.ts'
import { json, type Row } from '../infrastructure/database.ts'
import { BusinessAgentService, assetView } from './service.ts'
import { AgentResourceService } from './resources.ts'
import { createDemoAssets } from './office/index.ts'
import {
  agentSkills,
  agentTools,
  defaultSkillTools,
  type AgentAsset,
  type AgentDefinition,
} from './contracts.ts'
import type { KnowledgeBase } from './resource-contracts.ts'
import {
  isPristineBuiltinResource,
  isPristineLegacyExample,
  officeAgentExamples,
  previousPresentationExample,
} from './demo-definitions.ts'

interface DemoMarker {
  version?: number
  agentIds?: string[]
  assetIds?: string[]
  knowledgeBaseIds?: string[]
  agents?: AgentDefinition[]
  assets?: AgentAsset[]
  copiedVersion?: number
  copiedAgentIds?: string[]
}

/** First entry creates usable, persisted examples; subsequent entry only reads. */
export async function initializeAgentExamples(
  service: BusinessAgentService,
  account: Account,
  options: { copyLatest?: boolean } = {},
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
      return initialize(scoped, account, options)
    })
  } finally {
    await lease.release()
  }
}

async function initialize(
  service: BusinessAgentService,
  account: Account,
  options: { copyLatest?: boolean },
) {
  const resources = new AgentResourceService(service.options)
  await resources.ensureDefaults(account)
  const key = `business-agent-demo:${account.userId}`
  const [previous] = await service.options.db.query(
    'SELECT value FROM instance_settings WHERE key=$1',
    [key],
  )
  const old = previous ? json<DemoMarker>(previous.value, {}) : null
  if (old && (old.version ?? 0) >= 2) {
    if (old.version === 2) await upgradePristineExamples(service, account, old)
    if ((old.version ?? 0) < 4) {
      const example = officeAgentExamples[3]!
      // This example did not exist in earlier releases. The marker prevents
      // recreating it after a maintainer subsequently deletes it.
      const created = await service.save(account, {
        ...example,
        knowledgeBaseIds: [],
        knowledgeAssetIds: [],
        templateAssetIds: [],
        published: true,
      })
      old.agentIds = [...(old.agentIds ?? []), created.id]
      old.version = 4
      await saveMarker(service, account, old)
    }
    if ((old.version ?? 0) < 5) {
      for (const index of [1, 3]) {
        const id = old.agentIds?.[index]
        if (!id) continue
        const [row] = await service.options.db.query(
          'SELECT definition_json FROM business_agents WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL',
          [id, account.userId],
        )
        if (!row) continue
        const current = json<AgentDefinition>(
          row.definition_json,
          {} as AgentDefinition,
        )
        const latest =
          index === 1
            ? previousPresentationExample
            : officeAgentExamples[index]!
        const original = {
          ...latest,
          toolIds: latest.toolIds.filter((id) => id !== 'illustration_render'),
        }
        if (
          current.version !== 1 ||
          !current.published ||
          !Object.entries(original).every(
            ([key, value]) =>
              JSON.stringify(current[key as keyof AgentDefinition]) ===
              JSON.stringify(value),
          )
        )
          continue
        await service.save(account, { ...current, ...latest }, id)
      }
      old.version = 5
      await saveMarker(service, account, old)
    }
    if ((old.version ?? 0) < 6) {
      const id = old.agentIds?.[1]
      const [row] = id
        ? await service.options.db.query(
            'SELECT definition_json FROM business_agents WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL',
            [id, account.userId],
          )
        : []
      if (row) {
        const current = json<AgentDefinition>(
          row.definition_json,
          {} as AgentDefinition,
        )
        if (
          current.published &&
          Object.entries(previousPresentationExample).every(
            ([key, value]) =>
              JSON.stringify(current[key as keyof AgentDefinition]) ===
              JSON.stringify(value),
          )
        ) {
          try {
            await service.save(
              account,
              { ...current, ...officeAgentExamples[1] },
              id,
            )
          } catch (error) {
            // Explicitly disabled/deleted resources must not be restored by an upgrade.
            if (
              !(error instanceof ApiError) ||
              ![404, 422].includes(error.status)
            )
              throw error
          }
        }
      }
      old.version = 6
      await saveMarker(service, account, old)
    }
    if (options.copyLatest) await copyLatestExamples(service, account, old)
    return currentExamples(service, account, old)
  }

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
    version: 6,
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
  for (const [index, input] of officeAgentExamples.entries()) {
    agents.push(
      await service.save(account, {
        ...input,
        ...newExampleFlow(index),
        knowledgeBaseIds: associations[index]!,
        knowledgeAssetIds: [],
        templateAssetIds: [],
        published: true,
      }),
    )
  }
  return agents
}

/** New/copied examples opt in. Existing definitions and session snapshots stay unchanged. */
function newExampleFlow(index: number) {
  if (index !== 1 && index !== 3) return {}
  return {
    skillIds: [index === 1 ? 'presentation-flow' : 'document-flow'],
    skillPolicy: { mode: 'auto' as const },
  }
}

async function saveMarker(
  service: BusinessAgentService,
  account: Account,
  marker: DemoMarker,
) {
  await service.options.db.query(
    'UPDATE instance_settings SET value=$2,updated_at=$3 WHERE key=$1',
    [
      `business-agent-demo:${account.userId}`,
      JSON.stringify(marker),
      new Date().toISOString(),
    ],
  )
}

async function upgradePristineExamples(
  service: BusinessAgentService,
  account: Account,
  marker: DemoMarker,
) {
  const ids = marker.knowledgeBaseIds ?? []
  const associations = [[ids[0], ids[1]], [ids[0], ids[2]], [ids[0]]].map(
    (list) => list.filter((id): id is string => Boolean(id)),
  )
  // Built-in resources are independently versioned: do not replace an edited or disabled skill/tool.
  const resources = new AgentResourceService(service.options)
  const catalog = await resources.catalog(account)
  for (const skill of catalog.skills) {
    const latest = agentSkills.find((item) => item.id === skill.id)
    if (latest && isPristineBuiltinResource(skill))
      await resources.saveSkill(account, { ...skill, ...latest }, skill.id)
  }
  for (const tool of catalog.tools) {
    const latest = agentTools.find((item) => item.id === tool.id)
    if (latest && isPristineBuiltinResource(tool))
      await resources.saveTool(account, { ...tool, ...latest }, tool.id)
  }
  for (const [index, id] of (marker.agentIds ?? []).entries()) {
    const [row] = await service.options.db.query(
      'SELECT definition_json FROM business_agents WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE',
      [account.userId, id],
    )
    if (!row) continue
    const current = json<AgentDefinition>(
      row.definition_json,
      {} as AgentDefinition,
    )
    if (!isPristineLegacyExample(current, index, associations[index] ?? []))
      continue
    try {
      await service.save(
        account,
        { ...current, ...officeAgentExamples[index] },
        id,
      )
    } catch (error) {
      // Disabled/deleted linked resources remain under the maintainer's control.
      if (!(error instanceof ApiError) || ![404, 422].includes(error.status))
        throw error
    }
  }
  marker.version = 3
  await saveMarker(service, account, marker)
}

async function copyLatestExamples(
  service: BusinessAgentService,
  account: Account,
  marker: DemoMarker,
) {
  if (marker.copiedVersion === 7) return
  const resources = new AgentResourceService(service.options)
  const catalog = await resources.catalog(account)
  const skillIds = new Map<string, string>()
  // New skills are separate records; existing customized skills and disabled tools stay untouched.
  for (const skill of [...agentSkills].sort(
    (a, b) => Number('program' in a) - Number('program' in b),
  )) {
    const requiredToolIds = defaultSkillTools[skill.id]!
    if (
      requiredToolIds.some(
        (id) => !catalog.tools.some((tool) => tool.id === id && tool.enabled),
      )
    )
      throw new ApiError(
        422,
        '新版示例需要的工具已停用，请先在工具管理中明确启用后再复制',
      )
    const saved = await resources.saveSkill(account, {
      ...skill,
      ...('program' in skill
        ? {
            program: {
              ...skill.program,
              stages: skill.program.stages.map((stage) => ({
                ...stage,
                ...(stage.skillId
                  ? { skillId: skillIds.get(stage.skillId)! }
                  : {}),
              })),
            },
          }
        : {}),
      name: `${skill.name} · 办公版`,
      enabled: true,
      requiredToolIds,
    })
    skillIds.set(skill.id, saved.id)
  }
  const existingKnowledge = new Set(
    catalog.knowledgeBases
      .filter((base) => base.enabled)
      .map((base) => base.id),
  )
  const ids = marker.knowledgeBaseIds ?? []
  const associations = [[ids[0], ids[1]], [ids[0], ids[2]], [ids[0]]].map(
    (list) =>
      list.filter((id): id is string =>
        Boolean(id && existingKnowledge.has(id)),
      ),
  )
  const copies: AgentDefinition[] = []
  for (const [index, example] of officeAgentExamples.entries()) {
    copies.push(
      await service.save(account, {
        ...example,
        ...newExampleFlow(index),
        name: `${example.name} · 新版副本`,
        skillIds: (newExampleFlow(index).skillIds ?? example.skillIds).map(
          (id) => skillIds.get(id)!,
        ),
        knowledgeBaseIds: associations[index] ?? [],
        knowledgeAssetIds: [],
        templateAssetIds: [],
        published: false,
      }),
    )
  }
  marker.copiedVersion = 7
  marker.copiedAgentIds = copies.map((item) => item.id)
  await saveMarker(service, account, marker)
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
