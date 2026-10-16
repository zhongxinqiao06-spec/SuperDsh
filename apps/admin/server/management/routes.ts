import { randomUUID } from 'node:crypto'
import {
  ApiError,
  ApiRouter,
  object,
  text,
  utcNow,
} from '../http/api-router.ts'
import { IdentityService, json, type Row } from '../identity/service.ts'
import { publicOrigin } from '../identity/routes.ts'
import { registerAccountManagementRoutes, pageQuery } from './accounts.ts'
import { registerNavigationRoutes } from './navigation.ts'
import { registerDashboardRoutes } from './dashboard.ts'

export interface ManagementOptions {
  isOnline?: (connectorId: string) => boolean | Promise<boolean>
  disconnect?: (connectorId: string) => Promise<void>
  databaseUrl?: string
  version?: string
  instanceId?: string
}
function publicEmail(value: Row): Row {
  return {
    enabled: value.enabled === true,
    fromAddress: text(value.fromAddress),
    apiKeyConfigured: !!value.apiKey,
  }
}
function validSender(value: string): boolean {
  return (
    !/[\r\n]/.test(value) &&
    /(?:^|<)[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/.test(value)
  )
}
async function settings(identity: IdentityService): Promise<Row> {
  const oauth = await identity.settingsObject('oauth_provider'),
    email = await identity.settingsObject('email_verification')
  const { clientSecret: _secret, ...publicOAuth } = oauth
  return {
    registrationOpen:
      (await identity.getSetting('registration_open')) === 'true',
    oauthRegistrationOpen:
      (await identity.getSetting('oauth_registration_open')) === 'true',
    oauth: Object.keys(oauth).length ? publicOAuth : null,
    email: publicEmail(email),
  }
}
export function registerManagementRoutes(
  router: ApiRouter,
  identity: IdentityService,
  options: ManagementOptions = {},
): void {
  const db = identity.db,
    started = Date.now(),
    instanceId = options.instanceId || randomUUID()
  registerAccountManagementRoutes(router, identity)
  registerNavigationRoutes(router, identity)
  registerDashboardRoutes(router, identity)
  router.add('GET', '/admin/settings', () => settings(identity), {
    permission: 'settings.manage',
  })
  router.add(
    'PATCH',
    '/admin/settings',
    async (context) => {
      const patches: [string, string][] = []
      for (const [field, setting] of [
        ['registrationOpen', 'registration_open'],
        ['oauthRegistrationOpen', 'oauth_registration_open'],
      ]) {
        if (context.body[field!] !== undefined) {
          if (typeof context.body[field!] !== 'boolean')
            throw new ApiError(422, `${field} must be a boolean`)
          patches.push([setting!, context.body[field!] ? 'true' : 'false'])
        }
      }
      if (context.body.oauth !== undefined) {
        const patch = object(context.body.oauth),
          current = await identity.settingsObject('oauth_provider')
        if (!patch.clientSecret) delete patch.clientSecret
        const value: Row = {
          enabled: false,
          provider: 'oidc',
          label: 'OAuth',
          ...current,
          ...patch,
        }
        for (const field of ['authorizeUrl', 'tokenUrl', 'userInfoUrl'])
          if (value[field]) {
            let url: URL
            try {
              url = new URL(text(value[field]))
            } catch {
              throw new ApiError(422, 'invalid OAuth provider URL')
            }
            if (
              !['http:', 'https:'].includes(url.protocol) ||
              url.username ||
              url.password
            )
              throw new ApiError(422, 'invalid OAuth provider URL')
          }
        patches.push(['oauth_provider', JSON.stringify(value)])
      }
      if (context.body.email !== undefined) {
        const patch = object(context.body.email),
          value = await identity.settingsObject('email_verification')
        if (patch.enabled !== undefined) {
          if (typeof patch.enabled !== 'boolean')
            throw new ApiError(422, 'enabled must be a boolean')
          value.enabled = patch.enabled
        }
        if (patch.fromAddress !== undefined) {
          const sender = text(patch.fromAddress).trim()
          if (sender && !validSender(sender))
            throw new ApiError(422, 'Enter a valid sender email address.')
          value.fromAddress = sender
        }
        if (patch.clearApiKey) {
          if (text(patch.apiKey).trim())
            throw new ApiError(
              422,
              'Cannot replace and clear the API key together.',
            )
          value.apiKey = ''
        } else if (text(patch.apiKey).trim()) {
          const key = text(patch.apiKey).trim()
          if (!/^[\x21-\x7e]+$/.test(key))
            throw new ApiError(422, 'Enter a valid Resend API key.')
          value.apiKey = key
        }
        if (
          value.enabled &&
          (!value.apiKey || !validSender(text(value.fromAddress)))
        )
          throw new ApiError(
            422,
            'A Resend API key and sender address are required to enable verification.',
          )
        patches.push(['email_verification', JSON.stringify(value)])
      }
      const actor = await context.user('settings.manage')
      await db.transaction(async (connection) => {
        await connection.query('SELECT pg_advisory_xact_lock(4141455)')
        await identity.currentActor(actor, connection, 'settings.manage')
        for (const [key, value] of patches)
          await identity.setSetting(key, value, connection)
        await identity.audit(
          actor.userId,
          'settings.updated',
          'global',
          { fields: patches.map(([key]) => key) },
          connection,
        )
      })
      return settings(identity)
    },
    { permission: 'settings.manage' },
  )
  router.add(
    'GET',
    '/admin/devices',
    async (context) => {
      const { page, pageSize, search } = pageQuery(context.url, 200),
        where =
          "c.revoked=0 AND position($1 in lower(c.name || ' ' || c.id || ' ' || c.user_id || ' ' || coalesce(u.username,'') || ' ' || coalesce(c.device_os,'')))>0"
      const total = Number(
        (
          await db.query<Row>(
            `SELECT count(*)::text AS count FROM connectors c LEFT JOIN users u ON u.id=c.user_id WHERE ${where}`,
            [search],
          )
        )[0]?.count,
      )
      const rows = await db.query<Row>(
        `SELECT c.id,c.name,c.user_id,u.username,c.connector_kind,c.executor_kind,c.device_os,c.connector_version,c.status,c.last_seen_at,c.connection_blocked_at,c.connection_blocked_reason FROM connectors c LEFT JOIN users u ON u.id=c.user_id WHERE ${where} ORDER BY c.updated_at DESC,c.id LIMIT $2 OFFSET $3`,
        [search, pageSize, (page - 1) * pageSize],
      )
      return {
        devices: await Promise.all(
          rows.map(async (row) => ({
            id: row.id,
            name: row.name,
            userId: row.user_id,
            username: row.username,
            connectorKind: row.connector_kind,
            executorKind: row.executor_kind,
            deviceOs: row.device_os,
            version: row.connector_version,
            status: options.isOnline
              ? (await options.isOnline(text(row.id)))
                ? 'online'
                : 'offline'
              : row.status,
            lastSeenAt: row.last_seen_at,
            blockedAt: row.connection_blocked_at,
            blockedReason: row.connection_blocked_reason,
          })),
        ),
        total,
        page,
        pageSize,
      }
    },
    { permission: 'devices.inventory.read' },
  )
  for (const block of [true, false])
    router.add(
      'POST',
      `/admin/devices/{connector_id}/${block ? 'block' : 'resume'}`,
      async (context) => {
        const actor = await context.user('devices.connection.manage'),
          id = context.params.connector_id!,
          reason = text(context.body.reason)
        if (reason.length > 500)
          throw new ApiError(422, 'block reason exceeds 500 characters')
        await db.transaction(async (connection) => {
          await connection.query('SELECT pg_advisory_xact_lock(4141455)')
          await identity.currentActor(
            actor,
            connection,
            'devices.connection.manage',
          )
          const rows = await connection.query(
            'UPDATE connectors SET connection_blocked_at=$2,connection_blocked_by=$3,connection_blocked_reason=$4,updated_at=$5 WHERE id=$1 AND revoked=0 RETURNING id',
            [
              id,
              block ? utcNow() : null,
              block ? actor.userId : null,
              block ? reason : null,
              utcNow(),
            ],
          )
          if (!rows.length) throw new ApiError(404, 'device not found')
          await identity.audit(
            actor.userId,
            block ? 'device.blocked' : 'device.resumed',
            id,
            block ? { reason } : {},
            connection,
          )
        })
        if (block) await options.disconnect?.(id)
        return { status: block ? 'blocked' : 'resumed' }
      },
      { permission: 'devices.connection.manage' },
    )
  router.add(
    'GET',
    '/admin/service',
    (context) => {
      let databasePath: string | null = null
      try {
        const url = new URL(options.databaseUrl || '')
        databasePath = `${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname}`
      } catch {
        /* Display metadata never needs database credentials. */
      }
      return {
        endpoint: publicOrigin(context.request),
        version: options.version || '0.1.0',
        database: 'PostgreSQL',
        databasePath,
        databaseSchemaVersion: 'v2_39',
        coordination: 'redis',
        instanceId,
        startedAt: new Date(started).toISOString(),
        uptimeSeconds: Math.floor((Date.now() - started) / 1000),
        serverTime: utcNow(),
      }
    },
    { permission: 'settings.manage' },
  )
  const announcement = async () => ({
    enabled: false,
    markdown: '',
    publishedAt: null,
    ...(await identity.settingsObject('public_announcement')),
  })
  router.add(
    'GET',
    '/announcement',
    async () => {
      const value = await announcement()
      return {
        announcement:
          value.enabled && value.publishedAt
            ? { markdown: value.markdown, publishedAt: value.publishedAt }
            : null,
      }
    },
    { public: true },
  )
  router.add('GET', '/admin/announcement', announcement, {
    permission: 'settings.manage',
  })
  router.add(
    'PUT',
    '/admin/announcement',
    async (context) => {
      const { enabled, markdown } = context.body
      if (
        typeof enabled !== 'boolean' ||
        typeof markdown !== 'string' ||
        markdown.length > 20000 ||
        (enabled && !markdown.trim())
      )
        throw new ApiError(422, 'invalid announcement content')
      return db.transaction(async (connection) => {
        await connection.query('SELECT pg_advisory_xact_lock(4141455)')
        const actor = await context.user('settings.manage')
        await identity.currentActor(actor, connection, 'settings.manage')
        const current = json<Row>(
          await identity.getSetting('public_announcement', connection),
          {},
        )
        const unchanged =
          current.enabled === enabled && current.markdown === markdown
        const publishedAt =
          !enabled || unchanged
            ? current.publishedAt || null
            : new Date(
                Math.max(
                  Date.now(),
                  Date.parse(text(current.publishedAt)) + 1 || 0,
                ),
              ).toISOString()
        const value = { enabled, markdown, publishedAt }
        await identity.setSetting(
          'public_announcement',
          JSON.stringify(value),
          connection,
        )
        await identity.audit(
          actor.userId,
          'announcement.updated',
          'global',
          {},
          connection,
        )
        return value
      })
    },
    { permission: 'settings.manage' },
  )
}
