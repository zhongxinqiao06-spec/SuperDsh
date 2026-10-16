import type { ApiRouter } from '../http/api-router.ts'
import type { AgentResourceService } from './resources.ts'

export function registerAgentResourceRoutes(
  router: ApiRouter,
  service: AgentResourceService,
) {
  const options = { permission: 'agents.manage' }
  for (const kind of ['knowledge-bases', 'skills', 'tools'] as const)
    router.add(
      'GET',
      `/admin/${kind}`,
      (ctx) => service.list(kind, ctx.account!, ctx.url.searchParams),
      options,
    )

  router.add(
    'POST',
    '/admin/knowledge-bases',
    async (ctx) => ({
      knowledgeBase: await service.saveKnowledge(ctx.account!, ctx.body),
    }),
    { ...options, status: 201 },
  )
  router.add(
    'PUT',
    '/admin/knowledge-bases/{resource_id}',
    async (ctx) => ({
      knowledgeBase: await service.saveKnowledge(
        ctx.account!,
        ctx.body,
        ctx.params.resource_id!,
      ),
    }),
    options,
  )
  router.add(
    'POST',
    '/admin/skills',
    async (ctx) => ({ skill: await service.saveSkill(ctx.account!, ctx.body) }),
    { ...options, status: 201 },
  )
  router.add(
    'PUT',
    '/admin/skills/{resource_id}',
    async (ctx) => ({
      skill: await service.saveSkill(
        ctx.account!,
        ctx.body,
        ctx.params.resource_id!,
      ),
    }),
    options,
  )
  router.add(
    'PUT',
    '/admin/tools/{resource_id}',
    async (ctx) => ({
      tool: await service.saveTool(
        ctx.account!,
        ctx.body,
        ctx.params.resource_id!,
      ),
    }),
    options,
  )
  for (const kind of ['knowledge-bases', 'skills'] as const)
    router.add(
      'DELETE',
      `/admin/${kind}/{resource_id}`,
      (ctx) => service.remove(kind, ctx.account!, ctx.params.resource_id!),
      options,
    )
}
