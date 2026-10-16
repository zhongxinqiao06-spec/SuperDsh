import { ApiError, text } from '../http/api-router.ts'
import type { Database } from '../infrastructure/database.ts'
import type { AgentDefinition } from './contracts.ts'
import type { KnowledgeBase } from './resource-contracts.ts'

/** Resolve collection membership at session creation, then freeze asset IDs. */
export async function resolveAgentAssets(
  db: Database,
  owner: string,
  input: Pick<AgentDefinition, 'knowledgeAssetIds' | 'templateAssetIds'>,
  knowledgeBases: KnowledgeBase[],
) {
  const directIds = [...input.knowledgeAssetIds, ...input.templateAssetIds]
  const ids = [
    ...new Set([
      ...directIds,
      ...knowledgeBases.flatMap((base) => base.assetIds),
    ]),
  ]
  const assets = await db.query(
    'SELECT * FROM business_agent_assets WHERE id=ANY($1::text[]) AND owner_user_id=$2',
    [ids, owner],
  )
  if (assets.length !== ids.length)
    throw new ApiError(422, '资料不存在或不属于当前维护者')
  for (const asset of assets) {
    if (
      (input.knowledgeAssetIds.includes(text(asset.id)) &&
        asset.kind !== 'knowledge') ||
      (input.templateAssetIds.includes(text(asset.id)) &&
        asset.kind === 'knowledge')
    )
      throw new ApiError(422, '资料和模板分类不匹配')
  }
  for (const kind of ['spreadsheet-template', 'presentation-template'])
    if (assets.filter((asset) => asset.kind === kind).length > 1)
      throw new ApiError(422, '关联知识库中同类输出只能绑定一个模板')
  return {
    assets,
    knowledgeAssetIds: assets
      .filter((asset) => asset.kind === 'knowledge')
      .map((asset) => text(asset.id)),
    templateAssetIds: assets
      .filter((asset) => asset.kind !== 'knowledge')
      .map((asset) => text(asset.id)),
  }
}
