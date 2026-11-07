import {
  ApiError,
  requiredText,
  text,
  type ApiRouter,
} from '../http/api-router.ts'
import { json } from '../infrastructure/database.ts'
import type { BusinessAgentService } from './service.ts'
import type { KnowledgeBase } from './resource-contracts.ts'
import { reparseLegacyKnowledgeAsset } from './knowledge-reparse.ts'

export function registerKnowledgeIndexRoutes(
  router: ApiRouter,
  service: BusinessAgentService,
) {
  const options = { permission: 'agents.manage' }
  async function assets(owner: string, id: string) {
    const [row] = await service.options.db.query(
      'SELECT definition_json FROM business_knowledge_bases WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL',
      [owner, id],
    )
    if (!row) throw new ApiError(404, '知识库不存在')
    const knowledge = json<KnowledgeBase>(
      row.definition_json,
      {} as KnowledgeBase,
    )
    return service.options.db.query(
      "SELECT id,name,sha256,extracted_text,source_segments_json FROM business_agent_assets WHERE owner_user_id=$1 AND id=ANY($2::text[]) AND kind='knowledge'",
      [owner, knowledge.assetIds],
    )
  }
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
      let rows = await assets(ctx.account!.userId, ctx.params.resource_id!)
      if (!service.options.knowledgeIndex)
        throw new ApiError(503, '知识库 Qdrant 尚未配置')
      if (ctx.body.assetId !== undefined) {
        const id = requiredText(ctx.body.assetId, 'assetId', 200)
        rows = rows.filter((row) => row.id === id)
        if (!rows.length) throw new ApiError(404, '资料不属于当前知识库')
      }
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index]!
        try {
          rows[index] = await reparseLegacyKnowledgeAsset(
            service.options.db,
            ctx.account!.userId,
            row,
            ctx.signal,
            service.options.files.library,
          )
        } catch (error) {
          ctx.signal.throwIfAborted()
          service.options.knowledgeIndex.recordDocumentFailure(
            ctx.account!.userId,
            row,
            error instanceof ApiError
              ? error.message
              : '资料重新解析失败，请重试',
          )
          throw error
        }
      }
      const result = await service.options.knowledgeIndex.index(
        ctx.account!.userId,
        rows,
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
  router.add(
    'GET',
    '/admin/knowledge-bases/{resource_id}/index',
    async (ctx) => {
      const rows = await assets(ctx.account!.userId, ctx.params.resource_id!)
      if (!service.options.knowledgeIndex)
        throw new ApiError(503, '知识库 Qdrant 尚未配置')
      return {
        items: await service.options.knowledgeIndex.documentStatus(
          ctx.account!.userId,
          rows,
          ctx.signal,
        ),
      }
    },
    options,
  )
  router.add(
    'POST',
    '/admin/knowledge-bases/{resource_id}/search',
    async (ctx) => {
      const rows = await assets(ctx.account!.userId, ctx.params.resource_id!)
      if (!service.options.knowledgeIndex)
        throw new ApiError(503, '知识库 Qdrant 尚未配置')
      const query = requiredText(ctx.body.query, '检索问题', 200)
      return {
        sources: await service.options.knowledgeIndex.search(
          ctx.account!.userId,
          rows,
          query,
          8,
          ctx.signal,
        ),
      }
    },
    options,
  )
}
