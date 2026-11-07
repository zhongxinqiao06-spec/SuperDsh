import {
  ApiError,
  integer,
  object,
  requiredText,
  text,
  type ApiRouter,
} from '../http/api-router.ts'
import type { ModelCapability } from '@superdsh/core/contracts/platform'
import { ModelConfigurationService } from './configuration-service.ts'
import { modelCapabilities } from './capabilities.ts'
import { checkModelConnection } from './connection-check.ts'

export function registerModelConfigurationRoutes(
  router: ApiRouter,
  service: ModelConfigurationService,
  audit: (actor: string, action: string, target: string) => Promise<void>,
) {
  const manage = { permission: 'models.manage' }
  router.add(
    'GET',
    '/admin/models/configurations',
    async () => ({
      configurations: await service.configurations(),
      connections: await service.connections(),
      capabilities: modelCapabilities,
      defaults: await service.defaults(),
    }),
    manage,
  )
  for (const [plural, save] of [
    ['connections', service.saveConnection.bind(service)],
    ['configurations', service.saveConfiguration.bind(service)],
  ] as const) {
    router.add(
      'POST',
      '/admin/models/' + plural,
      async (ctx) => {
        const item = await save(undefined, ctx.body)
        await audit(ctx.account!.userId, 'model.' + plural + '.create', item.id)
        return item
      },
      manage,
    )
    router.add(
      'PATCH',
      '/admin/models/' + plural + '/{id}',
      async (ctx) => {
        const item = await save(ctx.params.id!, ctx.body)
        await audit(ctx.account!.userId, 'model.' + plural + '.update', item.id)
        return item
      },
      manage,
    )
  }
  router.add(
    'PUT',
    '/admin/models/defaults/{capability}',
    async (ctx) => {
      await service.setDefault(
        ctx.params.capability as ModelCapability,
        text(ctx.body.configurationId) || null,
        integer(ctx.body.revision, -1, 0),
      )
      await audit(
        ctx.account!.userId,
        'model.default.update',
        ctx.params.capability!,
      )
      return { defaults: await service.defaults() }
    },
    manage,
  )
  router.add(
    'POST',
    '/admin/models/configurations/{id}/verify',
    async (ctx) => {
      const selected = (await service.configurations()).find(
        (item) => item.id === ctx.params.id,
      )
      if (!selected) throw new ApiError(404, '模型配置不存在')
      const value = await service.resolve(ctx.account!, {
        configurationId: selected.id,
        revision: selected.revision,
        capability: selected.capability,
      })
      return checkModelConnection({
        adapter: value.connection.adapter,
        baseUrl: value.connection.baseUrl,
        key: value.key,
        allowedOrigins:
          process.env.SUPERDSH_PERSONAL_MODEL_ALLOWED_ORIGINS || '',
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(15000)]),
      })
    },
    manage,
  )
  router.add(
    'GET',
    '/models/capabilities',
    (ctx) => service.catalog(ctx.account!),
    { permission: 'models.use' },
  )
  router.add(
    'GET',
    '/models/operations/{id}',
    async (ctx) => {
      const [row] = await service.options.db.query(
        'SELECT id,session_id,state,configuration_id,configuration_revision,provider_request_id,usage_json,result_json,error,updated_at FROM model_provider_operations WHERE id=$1 AND owner_user_id=$2',
        [requiredText(ctx.params.id, '操作 ID'), ctx.account!.userId],
      )
      if (!row) throw new ApiError(404, '操作记录不存在')
      return {
        id: row.id,
        sessionId: row.session_id,
        state: row.state,
        configurationId: row.configuration_id,
        configurationRevision: row.configuration_revision,
        requestId: row.provider_request_id,
        usage: object(JSON.parse(text(row.usage_json, '{}'))),
        result: JSON.parse(text(row.result_json, '{}')),
        error: row.error,
        updatedAt: row.updated_at,
      }
    },
    { permission: 'models.use' },
  )
}
