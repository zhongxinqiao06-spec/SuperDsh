import {
  ApiError,
  ApiRouter,
  integer,
  text,
  utcNow,
  type Account,
} from '../http/api-router.ts'
import type { SqlConnection } from '../infrastructure/database.ts'
import {
  IdentityService,
  displayName,
  json,
  randomToken,
  type Row,
} from '../identity/service.ts'
import { permissions } from '../identity/permissions.ts'

export function pageQuery(
  url: URL,
  fallback = 25,
): { page: number; pageSize: number; search: string } {
  return {
    page: integer(url.searchParams.get('page'), 1, 1),
    pageSize: integer(url.searchParams.get('pageSize'), fallback, 1, 200),
    search: text(url.searchParams.get('search')).trim().toLowerCase(),
  }
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
    throw new ApiError(422, 'expected a string list')
  return [...new Set(value)].sort()
}
function grantsWithin(grants: string[], actor: Account): void {
  if (grants.some((permission) => !actor.permissions.includes(permission)))
    throw new ApiError(
      403,
      'cannot grant or manage permissions you do not hold',
    )
}
export class AccountManagement {
  readonly identity: IdentityService
  constructor(identity: IdentityService) {
    this.identity = identity
  }
  async roles(connection: SqlConnection = this.identity.db) {
    return (await connection.query<Row>('SELECT * FROM roles ORDER BY id')).map(
      (row) => ({
        id: text(row.id),
        name: row.name,
        description: row.description,
        builtin: !!row.builtin,
        permissions: json<string[]>(row.permissions_json, []),
      }),
    )
  }
  async validateRoles(
    value: unknown,
    actor: Account,
    connection: SqlConnection = this.identity.db,
  ): Promise<string[]> {
    const requested = strings(value)
    if (!requested.length)
      throw new ApiError(422, 'at least one role is required')
    const roles = await this.roles(connection)
    for (const roleId of requested) {
      const role = roles.find((item) => item.id === roleId)
      if (!role) throw new ApiError(422, 'role not found')
      grantsWithin(role.permissions, actor)
    }
    return requested
  }
  async protectAdmin(user: Account, connection: SqlConnection): Promise<void> {
    if (user.role !== 'admin' || user.disabled || user.deletedAt) return
    const others = await connection.query(
      "SELECT id FROM users WHERE id<>$1 AND role='admin' AND disabled=0 AND deleted_at IS NULL",
      [user.userId],
    )
    if (!others.length)
      throw new ApiError(409, 'cannot remove the last active admin')
  }
  async updateUser(
    actor: Account,
    userId: string,
    body: Row,
    operation: 'edit' | 'delete' | 'restore' | 'reset' = 'edit',
  ): Promise<Account> {
    const identity = this.identity
    if (
      ['password', 'passwordVerifier', 'passwordSalt'].some((key) =>
        Object.hasOwn(body, key),
      )
    )
      throw new ApiError(
        409,
        "administrators cannot set another account's password; request recovery instead",
      )
    await identity.db.transaction(async (connection) => {
      await connection.query('SELECT pg_advisory_xact_lock(4141455)')
      const current = await identity.currentActor(
          actor,
          connection,
          'users.manage',
        ),
        target = await identity.getUser(userId, connection)
      grantsWithin(target.permissions, current)
      if (operation === 'delete' && actor.userId === userId)
        throw new ApiError(409, 'cannot delete yourself')
      const requested =
        body.roles !== undefined
          ? body.roles
          : body.role !== undefined
            ? [body.role]
            : undefined
      if (
        requested !== undefined &&
        !current.permissions.includes('roles.manage')
      )
        throw new ApiError(403, 'role management permission required')
      if (requested !== undefined && userId === actor.userId)
        throw new ApiError(409, 'cannot change your own roles')
      if (body.disabled === true && userId === actor.userId)
        throw new ApiError(409, 'cannot disable yourself')
      if (body.disabled !== undefined && typeof body.disabled !== 'boolean')
        throw new ApiError(422, 'disabled must be a boolean')
      const roleIds =
        requested !== undefined
          ? await this.validateRoles(requested, current, connection)
          : undefined
      if (
        operation === 'delete' ||
        body.disabled === true ||
        (roleIds && !roleIds.includes('admin'))
      )
        await this.protectAdmin(target, connection)
      if (operation === 'restore' && !target.deletedAt)
        throw new ApiError(409, 'only deleted accounts can be restored')
      if (operation === 'edit' && target.deletedAt && body.disabled === false)
        throw new ApiError(409, 'restore this account before enabling it')
      const updates: string[] = ['updated_at=$2'],
        values: unknown[] = [userId, utcNow()]
      const field = (column: string, value: unknown) => {
        values.push(value)
        updates.push(`${column}=$${values.length}`)
      }
      if (body.displayName !== undefined)
        field('display_name', displayName(body.displayName))
      if (roleIds) {
        await connection.query('DELETE FROM user_roles WHERE user_id=$1', [
          userId,
        ])
        for (const roleId of roleIds)
          await connection.query(
            'INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)',
            [userId, roleId],
          )
        field('role', roleIds.includes('admin') ? 'admin' : 'member')
      }
      if (operation === 'delete') {
        field('deleted_at', utcNow())
        field('deleted_by', actor.userId)
        field('disabled', 1)
      }
      if (operation === 'restore') {
        field('deleted_at', null)
        field('deleted_by', null)
        field('disabled', 1)
      }
      if (operation === 'reset') field('reset_required', 1)
      if (operation === 'edit' && body.disabled !== undefined)
        field('disabled', body.disabled ? 1 : 0)
      const changedAuthorization =
        operation !== 'edit' ||
        roleIds !== undefined ||
        body.disabled !== undefined
      if (changedAuthorization) updates.push('auth_version=auth_version+1')
      await connection.query(
        `UPDATE users SET ${updates.join(',')} WHERE id=$1`,
        values,
      )
      if (changedAuthorization)
        await connection.query(
          'UPDATE auth_sessions SET revoked_at=$2 WHERE user_id=$1 AND revoked_at IS NULL',
          [userId, utcNow()],
        )
      await identity.audit(
        actor.userId,
        operation === 'edit'
          ? 'user.updated'
          : operation === 'delete'
            ? 'user.deleted'
            : operation === 'restore'
              ? 'user.restored'
              : 'user.recovery.requested',
        userId,
        {},
        connection,
      )
    })
    await identity.options.onAccountChanged?.(userId, 'authorization')
    return identity.getUser(userId)
  }
  async saveRole(
    actor: Account,
    id: string | undefined,
    body: Row,
  ): Promise<Row> {
    const grants = strings(body.permissions),
      name = text(body.name).trim(),
      description = text(body.description)
    if (
      !name ||
      name.length > 64 ||
      description.length > 500 ||
      grants.some((grant) => !Object.hasOwn(permissions, grant))
    )
      throw new ApiError(422, 'invalid role or unknown permission')
    const identity = this.identity,
      roleId = id || `role_${randomToken(12)}`
    const affected = await identity.db.transaction(async (connection) => {
      await connection.query('SELECT pg_advisory_xact_lock(4141455)')
      const current = await identity.currentActor(
        actor,
        connection,
        'roles.manage',
      )
      grantsWithin(grants, current)
      let affected: { id: string }[] = []
      if (id) {
        const old = (await this.roles(connection)).find(
          (role) => role.id === id,
        )
        if (!old) throw new ApiError(404, 'role not found')
        if (old.builtin)
          throw new ApiError(409, 'builtin roles cannot be edited')
        grantsWithin(old.permissions, current)
        await connection.query(
          'UPDATE roles SET name=$2,description=$3,permissions_json=$4,updated_at=$5 WHERE id=$1',
          [id, name, description, JSON.stringify(grants), utcNow()],
        )
        affected = await connection.query<{ id: string }>(
          'UPDATE users SET auth_version=auth_version+1 WHERE id IN(SELECT user_id FROM user_roles WHERE role_id=$1) OR role=$1 RETURNING id',
          [id],
        )
      } else
        await connection.query(
          'INSERT INTO roles(id,name,description,builtin,permissions_json,updated_at) VALUES($1,$2,$3,0,$4,$5)',
          [roleId, name, description, JSON.stringify(grants), utcNow()],
        )
      await identity.audit(
        actor.userId,
        id ? 'role.updated' : 'role.created',
        roleId,
        {},
        connection,
      )
      return affected
    })
    for (const user of affected)
      await identity.options.onAccountChanged?.(user.id, 'authorization')
    return {
      id: roleId,
      name,
      description,
      permissions: grants,
      builtin: false,
    }
  }
}
export function registerAccountManagementRoutes(
  router: ApiRouter,
  identity: IdentityService,
): void {
  const db = identity.db,
    management = new AccountManagement(identity)
  router.add(
    'GET',
    '/admin/users',
    async (context) => {
      const { page, pageSize, search } = pageQuery(context.url, 50),
        where =
          "position($1 in lower(coalesce(username,'') || ' ' || coalesce(email,'') || ' ' || display_name))>0"
      const total = Number(
        (
          await db.query<Row>(
            `SELECT count(*)::text AS count FROM users WHERE ${where}`,
            [search],
          )
        )[0]?.count,
      )
      const rows = await db.query<Row>(
        `SELECT * FROM users WHERE ${where} ORDER BY created_at,id LIMIT $2 OFFSET $3`,
        [search, pageSize, (page - 1) * pageSize],
      )
      return {
        users: await Promise.all(rows.map((row) => identity.userFromRow(row))),
        total,
        page,
        pageSize,
        serverTime: utcNow(),
      }
    },
    { permission: 'users.read' },
  )
  router.add(
    'POST',
    '/admin/users',
    async (context) => {
      const actor = await context.user('users.manage'),
        body = context.body,
        roles = body.roles || [body.role || 'member']
      const selected = await management.validateRoles(roles, actor)
      if (
        (selected.length !== 1 || selected[0] !== 'member') &&
        !actor.permissions.includes('roles.manage')
      )
        throw new ApiError(403, 'role management permission required')
      return identity.createUser(body, {
        trustEmail: false,
        actor,
        initialRoles: selected,
      })
    },
    { permission: 'users.manage', status: 201 },
  )
  router.add(
    'PATCH',
    '/admin/users/{user_id}',
    async (context) =>
      management.updateUser(
        await context.user('users.manage'),
        context.params.user_id!,
        context.body,
      ),
    { permission: 'users.manage' },
  )
  router.add(
    'DELETE',
    '/admin/users/{user_id}',
    async (context) => {
      await management.updateUser(
        await context.user('users.manage'),
        context.params.user_id!,
        {},
        'delete',
      )
    },
    { permission: 'users.manage' },
  )
  router.add(
    'POST',
    '/admin/users/{user_id}/restore',
    async (context) =>
      management.updateUser(
        await context.user('users.manage'),
        context.params.user_id!,
        {},
        'restore',
      ),
    { permission: 'users.manage' },
  )
  router.add(
    'POST',
    '/admin/users/{user_id}/password-reset',
    async (context) => {
      await management.updateUser(
        await context.user('users.manage'),
        context.params.user_id!,
        {},
        'reset',
      )
      return { status: 'recovery_required' }
    },
    { permission: 'users.manage' },
  )
  router.add(
    'GET',
    '/admin/roles',
    async () => ({
      roles: await management.roles(),
      permissions: Object.entries(permissions).map(([id, label]) => ({
        id,
        label,
      })),
    }),
    { permission: 'roles.manage' },
  )
  router.add(
    'POST',
    '/admin/roles',
    async (context) =>
      management.saveRole(
        await context.user('roles.manage'),
        undefined,
        context.body,
      ),
    { permission: 'roles.manage', status: 201 },
  )
  router.add(
    'PATCH',
    '/admin/roles/{role_id}',
    async (context) =>
      management.saveRole(
        await context.user('roles.manage'),
        context.params.role_id,
        context.body,
      ),
    { permission: 'roles.manage' },
  )
  router.add(
    'DELETE',
    '/admin/roles/{role_id}',
    async (context) => {
      const actor = await context.user('roles.manage'),
        id = context.params.role_id!
      await db.transaction(async (connection) => {
        await connection.query('SELECT pg_advisory_xact_lock(4141455)')
        await identity.currentActor(actor, connection, 'roles.manage')
        const role = (await management.roles(connection)).find(
          (item) => item.id === id,
        )
        if (!role) throw new ApiError(404, 'role not found')
        if (role.builtin)
          throw new ApiError(409, 'builtin roles cannot be deleted')
        grantsWithin(role.permissions, actor)
        if (
          (
            await connection.query(
              'SELECT user_id FROM user_roles WHERE role_id=$1 LIMIT 1',
              [id],
            )
          ).length
        )
          throw new ApiError(
            409,
            'remove role assignments before deleting this role',
          )
        await connection.query('DELETE FROM roles WHERE id=$1', [id])
        await identity.audit(actor.userId, 'role.deleted', id, {}, connection)
      })
    },
    { permission: 'roles.manage' },
  )
  router.add(
    'GET',
    '/admin/audit',
    async (context) => {
      const { page, pageSize, search } = pageQuery(context.url, 200),
        where =
          "position($1 in lower(action || ' ' || actor_id || ' ' || target_id))>0"
      const total = Number(
        (
          await db.query<Row>(
            `SELECT count(*)::text AS count FROM identity_audit WHERE ${where}`,
            [search],
          )
        )[0]?.count,
      )
      const rows = await db.query<Row>(
        `SELECT * FROM identity_audit WHERE ${where} ORDER BY created_at DESC,id LIMIT $2 OFFSET $3`,
        [search, pageSize, (page - 1) * pageSize],
      )
      return {
        events: rows.map((row) => ({
          id: row.id,
          actorId: row.actor_id,
          action: row.action,
          targetId: row.target_id,
          createdAt: row.created_at,
          detail: json(row.detail_json, {}),
        })),
        total,
        page,
        pageSize,
      }
    },
    { permission: 'audit.read' },
  )
}
