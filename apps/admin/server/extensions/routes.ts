import type { ApiRouter } from '../http/api-router.ts'
import type { ExtensionService } from './service.ts'

export function registerExtensionRoutes(
  router: ApiRouter,
  service: ExtensionService,
) {
  router.add(
    'GET',
    '/admin/extensions',
    async (ctx) => ({ items: await service.list(ctx.account!) }),
    { permission: 'agents.manage' },
  )
  const manage = { permission: 'extensions.manage' }
  router.add(
    'POST',
    '/admin/extensions/install',
    (ctx) => service.install(ctx.account!, ctx.body, ctx.signal),
    { ...manage, status: 201, maxBodyBytes: 24 * 1024 * 1024 },
  )
  router.add(
    'POST',
    '/admin/extensions/mcp/discover',
    (ctx) => service.discover(ctx.account!, ctx.body, ctx.signal),
    manage,
  )
  router.add(
    'POST',
    '/admin/extensions/mcp',
    (ctx) => service.connect(ctx.account!, ctx.body, ctx.signal),
    { ...manage, status: 201 },
  )
  router.add(
    'PUT',
    '/admin/extensions/{source_id}',
    (ctx) =>
      service.update(ctx.account!, ctx.params.source_id!, ctx.body, ctx.signal),
    manage,
  )
  router.add(
    'POST',
    '/admin/extensions/{source_id}/check',
    (ctx) =>
      service.check(
        ctx.account!,
        ctx.params.source_id!,
        typeof ctx.body.version === 'string' ? ctx.body.version : '',
        ctx.signal,
      ),
    manage,
  )
}
