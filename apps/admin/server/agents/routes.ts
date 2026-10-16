import { type ApiRouter } from '../http/api-router.ts'
import { BusinessAgentService } from './service.ts'
import { initializeAgentExamples } from './demo.ts'

export function registerBusinessAgentRoutes(
  router: ApiRouter,
  service: BusinessAgentService,
) {
  router.add(
    'GET',
    '/agents',
    (ctx) => service.list(ctx.account!, ctx.url.searchParams),
    { permission: 'sessions.run' },
  )
  router.add(
    'GET',
    '/admin/agents',
    (ctx) => service.list(ctx.account!, ctx.url.searchParams, true),
    { permission: 'agents.manage' },
  )
  router.add(
    'GET',
    '/admin/agents/catalog',
    (ctx) => service.catalog(ctx.account!),
    { permission: 'agents.manage' },
  )
  router.add(
    'POST',
    '/admin/agents',
    async (ctx) => ({ agent: await service.save(ctx.account!, ctx.body) }),
    { permission: 'agents.manage', status: 201 },
  )
  router.add(
    'PUT',
    '/admin/agents/{agent_id}',
    async (ctx) => ({
      agent: await service.save(ctx.account!, ctx.body, ctx.params.agent_id!),
    }),
    { permission: 'agents.manage' },
  )
  router.add(
    'DELETE',
    '/admin/agents/{agent_id}',
    (ctx) => service.remove(ctx.account!, ctx.params.agent_id!),
    { permission: 'agents.manage' },
  )
  router.add(
    'POST',
    '/admin/agents/assets',
    async (ctx) => ({ asset: await service.upload(ctx.account!, ctx.body) }),
    { permission: 'agents.manage', status: 201 },
  )
  router.add(
    'GET',
    '/admin/agents/assets/{asset_id}/preview',
    (ctx) =>
      service.previewAsset(ctx.account!, ctx.params.asset_id!, ctx.signal),
    { permission: 'agents.manage' },
  )
  router.add(
    'GET',
    '/admin/agents/assets/{asset_id}/download',
    (ctx) => service.asset(ctx.account!, ctx.params.asset_id!),
    { permission: 'agents.manage' },
  )
  router.add(
    'POST',
    '/admin/agents/demo',
    (ctx) => initializeAgentExamples(service, ctx.account!),
    { permission: 'agents.manage' },
  )
  router.add(
    'POST',
    '/admin/agents/initialize',
    (ctx) => initializeAgentExamples(service, ctx.account!),
    { permission: 'agents.manage' },
  )
  router.add(
    'GET',
    '/sessions/{session_id}/agent-artifacts',
    (ctx) => service.artifacts(ctx.account!, ctx.params.session_id!),
    { permission: 'files.read' },
  )
}
