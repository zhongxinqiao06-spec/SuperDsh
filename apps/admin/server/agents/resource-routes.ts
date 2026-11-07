import { ApiError, requiredText, type ApiRouter } from '../http/api-router.ts'
import type { AgentResourceService } from './resources.ts'
import { importSkillPackage } from './skill-package.ts'
import { matchSkills } from '../skills/matching.ts'

export function registerAgentResourceRoutes(
  router: ApiRouter,
  service: AgentResourceService,
) {
  const options = { permission: 'agents.manage' }
  router.add(
    'POST',
    '/admin/skills/match-preview',
    async (ctx) => {
      const catalog = await service.catalog(ctx.account!)
      const ids = Array.isArray(ctx.body.skillIds) ? ctx.body.skillIds : []
      return {
        candidates: matchSkills(
          catalog.skills.filter(
            (skill) => !ids.length || ids.includes(skill.id),
          ),
          requiredText(ctx.body.request, '试验需求', 12000),
        ),
      }
    },
    options,
  )
  router.add(
    'POST',
    '/admin/skills/{resource_id}/publish',
    async (ctx) => ({
      skill: await service.publishSkill(
        ctx.account!,
        ctx.params.resource_id!,
        Number(ctx.body.version),
      ),
    }),
    options,
  )
  router.add(
    'POST',
    '/admin/skills/import-extension',
    async (ctx) => {
      const extensions = service.options.extensions
      if (!extensions) throw new ApiError(503, '扩展服务尚未就绪')
      const bytes = await extensions.skillArchive(
        ctx.account!,
        requiredText(ctx.body.sourceId, '扩展来源', 100),
        requiredText(ctx.body.sourceVersion, '扩展版本', 100),
        requiredText(ctx.body.skillId, '技能标识', 100),
        ctx.signal,
      )
      return {
        skill: await importSkillPackage(
          service,
          ctx.account!,
          { ...ctx.body, contentBase64: bytes.toString('base64') },
          ctx.signal,
        ),
      }
    },
    { ...options, status: 201 },
  )
  router.add(
    'POST',
    '/admin/skills/import',
    async (ctx) => ({
      skill: await importSkillPackage(
        service,
        ctx.account!,
        ctx.body,
        ctx.signal,
      ),
    }),
    { ...options, status: 201, maxBodyBytes: 17 * 1024 * 1024 },
  )
  for (const kind of ['knowledge-bases', 'skills', 'tools'] as const) {
    router.add(
      'GET',
      `/admin/${kind}/{resource_id}/versions`,
      (ctx) =>
        service.history(
          kind,
          ctx.account!,
          ctx.params.resource_id!,
          ctx.url.searchParams,
        ),
      options,
    )
    router.add(
      'POST',
      `/admin/${kind}/{resource_id}/restore`,
      async (ctx) => ({
        resource: await service.restore(
          kind,
          ctx.account!,
          ctx.params.resource_id!,
          ctx.body,
        ),
      }),
      options,
    )
    router.add(
      'GET',
      `/admin/${kind}`,
      (ctx) => service.list(kind, ctx.account!, ctx.url.searchParams),
      options,
    )
  }

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
    'POST',
    '/admin/tools',
    async (ctx) => ({ tool: await service.saveTool(ctx.account!, ctx.body) }),
    { ...options, status: 201 },
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
  for (const kind of ['knowledge-bases', 'skills', 'tools'] as const)
    router.add(
      'DELETE',
      `/admin/${kind}/{resource_id}`,
      (ctx) => service.remove(kind, ctx.account!, ctx.params.resource_id!),
      options,
    )
}
