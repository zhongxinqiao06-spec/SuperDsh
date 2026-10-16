import { ApiError, text, type ApiRouter } from '../http/api-router.ts'
import { json } from '../infrastructure/database.ts'
import type { BusinessAgentService } from './service.ts'
import type { KnowledgeBase } from './resource-contracts.ts'

export function registerKnowledgeIndexRoutes(
  router: ApiRouter,
  service: BusinessAgentService,
) {
  const options = { permission: 'agents.manage' }
  router.add(
    'GET',
    '/admin/knowledge-bases/search-status',
    () =>
      service.options.knowledgeIndex?.status() ?? {
        engine: 'qdrant',
        ready: false,
        message: '知识库 Qdrant 尚未配置',
      },
    options,
  )
  router.add(
    'POST',
    '/admin/knowledge-bases/{resource_id}/index',
    async (ctx) => {
      const [row] = await service.options.db.query(
        'SELECT definition_json FROM business_knowledge_bases WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL',
        [ctx.account!.userId, ctx.params.resource_id!],
      )
      if (!row) throw new ApiError(404, '知识库不存在')
      if (!service.options.knowledgeIndex)
        throw new ApiError(503, '知识库 Qdrant 尚未配置')
      const knowledge = json<KnowledgeBase>(
        row.definition_json,
        {} as KnowledgeBase,
      )
      const assets = await service.options.db.query(
        "SELECT id,name,sha256,extracted_text FROM business_agent_assets WHERE owner_user_id=$1 AND id=ANY($2::text[]) AND kind='knowledge'",
        [ctx.account!.userId, knowledge.assetIds],
      )
      const result = await service.options.knowledgeIndex.index(
        ctx.account!.userId,
        assets,
        ctx.signal,
        true,
      )
      await service.options.audit(
        ctx.account!.userId,
        'knowledge.index',
        text(ctx.params.resource_id),
        result,
      )
      return result
    },
    options,
  )
}
