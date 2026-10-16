import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { domainToASCII } from 'node:url'
import {
  ApiError,
  bearer,
  text,
  utcNow,
  type Account,
} from '../http/api-router.ts'
import type { Database, SqlConnection } from '../infrastructure/database.ts'
import { createAuthCrypto } from './auth-crypto.ts'
import { memberPermissions, permissions } from './permissions.ts'

export type Row = Record<string, unknown>
export const tokenHash = (value: string) =>
  createHash('sha256').update(value).digest('hex')
export const randomToken = (size = 24) =>
  randomBytes(size).toString('base64url')
export const json = <T>(value: unknown, fallback: T): T => {
  try {
    return typeof value === 'string' ? (JSON.parse(value) as T) : fallback
  } catch {
    return fallback
  }
}
export function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left),
    b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}
export function emailAddress(value: unknown): string {
  const raw = text(value).trim().toLowerCase(),
    parts = raw.split('@')
  const local = parts[0] || '',
    domain = domainToASCII(parts[1] || '')
  if (
    parts.length !== 2 ||
    local.length > 64 ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..') ||
    domain.split('.').length < 2 ||
    domain
      .split('.')
      .some((part) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)) ||
    raw.length > 254
  )
    throw new ApiError(422, 'a valid email address is required')
  return `${local}@${domain}`
}
export function displayName(value: unknown): string {
  const name = text(value).trim()
  if (!name || name.length > 64 || /[\u0000-\u001f]/.test(name))
    throw new ApiError(422, 'display name must be 1-64 characters')
  return name
}
export interface IdentityOptions {
  secret: string
  setupToken?: string
  setupTokenExpiresAt?: string
  onPrepareAgent?: (userId: string) => void
  onAccountChanged?: (
    userId: string,
    reason: 'session' | 'credentials' | 'authorization',
  ) => Promise<void> | void
}
export interface Login {
  user: Account
  accessToken: string
  refreshToken: string
  sessionId: string
}

/** SQL owns identity and revocation; signed access claims never imply live grants. */
export class IdentityService {
  readonly db: Database
  readonly options: IdentityOptions
  readonly crypto: ReturnType<typeof createAuthCrypto>
  private readonly activitySeen = new Map<string, number>()
  constructor(db: Database, options: IdentityOptions) {
    this.db = db
    this.options = options
    this.crypto = createAuthCrypto({
      secret: options.secret,
      nowSeconds: () => Date.now() / 1000,
    })
  }
  async seedBuiltinRoles(): Promise<void> {
    for (const [id, name, grants] of [
      ['admin', 'Administrator', Object.keys(permissions)],
      ['member', 'Member', memberPermissions],
    ] as const)
      await this.db.query(
        'INSERT INTO roles(id,name,description,builtin,permissions_json,updated_at) VALUES($1,$2,$3,1,$4,$5) ON CONFLICT(id) DO NOTHING',
        [id, name, '', JSON.stringify(grants), utcNow()],
      )
  }
  async getUser(
    id: string,
    connection: SqlConnection = this.db,
  ): Promise<Account> {
    const [row] = await connection.query<Row>(
      'SELECT * FROM users WHERE id=$1',
      [id],
    )
    if (!row) throw new ApiError(404, 'user not found')
    return this.userFromRow(row, connection)
  }
  async userFromRow(
    row: Row,
    connection: SqlConnection = this.db,
  ): Promise<Account> {
    const assignments = await connection.query<{ role_id: string }>(
      'SELECT role_id FROM user_roles WHERE user_id=$1 ORDER BY role_id',
      [row.id],
    )
    const roles = assignments.length
      ? assignments.map((value) => value.role_id)
      : [text(row.role)]
    const grants = await connection.query<{ permissions_json: string }>(
      'SELECT permissions_json FROM roles WHERE id=ANY($1::text[])',
      [roles],
    )
    return {
      userId: text(row.id),
      username: text(row.username),
      email: typeof row.email === 'string' ? row.email : null,
      emailVerified: !!row.email_verified_at,
      displayName: text(row.display_name),
      role: roles.includes('admin') ? 'admin' : 'member',
      roles,
      permissions: [
        ...new Set(
          grants.flatMap((grant) => json<string[]>(grant.permissions_json, [])),
        ),
      ].sort(),
      authzVersion: Number(row.auth_version || 0),
      resetRequired: !!row.reset_required,
      disabled: !!row.disabled,
      deletedAt: typeof row.deleted_at === 'string' ? row.deleted_at : null,
      avatar: row.avatar ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
  async authenticateToken(token: string): Promise<Account | null> {
    const claims = this.crypto.userAccessClaims(token)
    if (!claims?.sid || claims.ver === undefined) return null
    const [row] = await this.db.query<Row>(
      `SELECT u.* FROM users u JOIN auth_sessions s ON s.user_id=u.id
      WHERE u.id=$1 AND s.id=$2 AND u.auth_version=$3 AND s.auth_version=$3
      AND u.disabled=0 AND u.deleted_at IS NULL AND s.revoked_at IS NULL AND s.expires_at>$4`,
      [claims.sub, claims.sid, claims.ver, utcNow()],
    )
    return row ? this.userFromRow(row) : null
  }
  authorize = async (
    request: IncomingMessage,
    permission?: string,
  ): Promise<Account> => {
    const account = await this.authenticateToken(bearer(request))
    if (!account) throw new ApiError(401, 'login session expired or revoked')
    if (permission && account.resetRequired)
      throw new ApiError(403, 'password change required')
    if (permission && !account.permissions.includes(permission))
      throw new ApiError(403, `permission required: ${permission}`)
    const now = Date.now()
    if (now - (this.activitySeen.get(account.userId) || 0) >= 60000) {
      const timestamp = utcNow()
      await this.db.query(
        'INSERT INTO platform_user_activity(user_id,activity_date,first_seen_at,last_seen_at,event_count) VALUES($1,$2,$3,$3,1) ON CONFLICT(user_id,activity_date) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at,event_count=platform_user_activity.event_count+1',
        [account.userId, timestamp.slice(0, 10), timestamp],
      )
      this.activitySeen.set(account.userId, now)
      if (this.activitySeen.size > 10000)
        for (const [id, seen] of this.activitySeen)
          if (now - seen > 60000) this.activitySeen.delete(id)
    }
    return account
  }
  async loginRow(identifier: string): Promise<Row | undefined> {
    const normalized = identifier.trim().toLowerCase()
    if (!normalized) throw new ApiError(422, 'login identifier is required')
    const column = normalized.includes('@') ? 'email' : 'username'
    const [row] = await this.db.query<Row>(
      `SELECT * FROM users WHERE ${column}=$1 AND disabled=0 AND deleted_at IS NULL ${column === 'email' ? 'AND email_verified_at IS NOT NULL' : ''}`,
      [column === 'email' ? emailAddress(normalized) : normalized],
    )
    return row
  }
  async verifyLogin(
    identifier: string,
    password: unknown,
    verifier?: unknown,
  ): Promise<Account | null> {
    const row = await this.loginRow(identifier)
    if (!row) return null
    const valid =
      typeof verifier === 'string'
        ? this.crypto.verifyPasswordVerifier(verifier, text(row.password_hash))
        : typeof password === 'string' &&
          (await this.crypto.verifyPassword(password, text(row.password_hash)))
    return valid ? this.userFromRow(row) : null
  }
  async issueLogin(userId: string, clientName = 'Browser'): Promise<Login> {
    return this.db.transaction(async (connection) => {
      await connection.query('SELECT pg_advisory_xact_lock(4141455)')
      const user = await this.getUser(userId, connection)
      if (user.disabled || user.deletedAt)
        throw new ApiError(403, 'account unavailable')
      const sid = `ses_${randomToken()}`,
        refresh = `${sid}.${randomToken(48)}`,
        now = utcNow()
      await connection.query(
        `INSERT INTO auth_sessions(id,user_id,refresh_hash,auth_version,client_name,created_at,last_seen_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$6,$7)`,
        [
          sid,
          userId,
          tokenHash(refresh),
          user.authzVersion,
          clientName.slice(0, 80),
          now,
          new Date(Date.now() + 30 * 86400000).toISOString(),
        ],
      )
      return this.loginPayload(user, sid, refresh)
    })
  }
  private loginPayload(user: Account, sid: string, refresh: string): Login {
    return {
      user,
      sessionId: sid,
      refreshToken: refresh,
      accessToken: this.crypto.createUserAccessToken(user.userId, {
        sessionId: sid,
        authVersion: user.authzVersion,
      }),
    }
  }
  async refreshLogin(refresh: string): Promise<Login | null> {
    const sid = refresh.split('.')[0],
      digest = tokenHash(refresh),
      now = utcNow()
    return this.db.transaction(async (connection) => {
      const [session] = await connection.query<Row>(
        'SELECT * FROM auth_sessions WHERE id=$1 FOR UPDATE',
        [sid],
      )
      if (!session || session.revoked_at || text(session.expires_at) <= now)
        return null
      if (!equalSecret(text(session.refresh_hash), digest)) {
        if (equalSecret(text(session.previous_refresh_hash), digest))
          await connection.query(
            'UPDATE auth_sessions SET revoked_at=$2 WHERE id=$1',
            [sid, now],
          )
        return null
      }
      const user = await this.getUser(text(session.user_id), connection)
      if (
        user.disabled ||
        user.deletedAt ||
        user.authzVersion !== session.auth_version
      ) {
        await connection.query(
          'UPDATE auth_sessions SET revoked_at=$2 WHERE id=$1',
          [sid, now],
        )
        return null
      }
      const rotated = `${sid}.${randomToken(48)}`
      await connection.query(
        'UPDATE auth_sessions SET refresh_hash=$2,previous_refresh_hash=$3,last_seen_at=$4 WHERE id=$1',
        [sid, tokenHash(rotated), digest, now],
      )
      return this.loginPayload(user, text(sid), rotated)
    })
  }
  async revokeLogin(options: {
    userId?: string
    sessionId?: string
    refresh?: string
  }): Promise<void> {
    const clauses: string[] = [],
      args: unknown[] = [utcNow()]
    for (const [column, value] of [
      ['user_id', options.userId],
      ['id', options.sessionId],
      [
        'refresh_hash',
        options.refresh ? tokenHash(options.refresh) : undefined,
      ],
    ]) {
      if (value) {
        args.push(value)
        clauses.push(`${column}=$${args.length}`)
      }
    }
    if (!clauses.length) return
    const rows = await this.db.query<{ user_id: string }>(
      `UPDATE auth_sessions SET revoked_at=$1 WHERE revoked_at IS NULL AND ${clauses.join(' AND ')} RETURNING user_id`,
      args,
    )
    for (const userId of new Set(rows.map((row) => row.user_id)))
      await this.options.onAccountChanged?.(userId, 'session')
  }
  async getSetting(
    key: string,
    connection: SqlConnection = this.db,
  ): Promise<string | null> {
    const [row] = await connection.query<{ value: string }>(
      'SELECT value FROM instance_settings WHERE key=$1',
      [key],
    )
    return row?.value ?? null
  }
  async setSetting(
    key: string,
    value: string,
    connection: SqlConnection = this.db,
  ): Promise<void> {
    await connection.query(
      'INSERT INTO instance_settings(key,value,updated_at) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at',
      [key, value, utcNow()],
    )
  }
  async settingsObject(key: string): Promise<Row> {
    return json<Row>(await this.getSetting(key), {})
  }
  async passwordHash(body: Row, prefix = ''): Promise<string> {
    const field = (name: string) =>
      prefix ? `${prefix}${name[0]!.toUpperCase()}${name.slice(1)}` : name
    const verifier = body[field('passwordVerifier')]
    if (typeof verifier === 'string') {
      try {
        return this.crypto.hashPasswordVerifier(
          verifier,
          text(body[field('passwordSalt')]),
        )
      } catch {
        throw new ApiError(422, 'password verifier or salt is invalid')
      }
    }
    const password = body[field('password')]
    if (
      typeof password !== 'string' ||
      password.length < 8 ||
      password.length > 1024
    )
      throw new ApiError(422, 'password must be 8-1024 characters')
    return this.crypto.hashPassword(password)
  }
  async createUser(
    body: Row,
    options: {
      role?: string
      bootstrap?: boolean
      trustEmail?: boolean
      requireVerification?: boolean
      actor?: Account
      initialRoles?: string[]
      consumeCode?: (
        connection: SqlConnection,
        email: string,
      ) => Promise<boolean>
    } = {},
  ): Promise<Account> {
    const email = body.email ? emailAddress(body.email) : null
    let username = text(body.username).trim().toLowerCase()
    const explicit = !!username
    if (!username && email) {
      username = email
        .split('@')[0]!
        .replace(/[^a-z0-9_-]/g, '-')
        .slice(0, 32)
      if (username.length < 3) username = `user-${username}`
    }
    if (!/^[a-z0-9_-]{3,32}$/.test(username))
      throw new ApiError(
        422,
        'username must be 3-32 lowercase letters, digits, hyphen or underscore',
      )
    const name = displayName(body.displayName),
      stored = await this.passwordHash(body),
      id = `usr_${randomBytes(12).toString('hex')}`,
      now = utcNow(),
      role = options.role || 'member'
    let verified = true
    try {
      await this.db.transaction(async (connection) => {
        await connection.query('SELECT pg_advisory_xact_lock(4141455)')
        let initialRoles = [role]
        if (options.actor) {
          const actor = await this.currentActor(
            options.actor,
            connection,
            'users.manage',
          )
          initialRoles = options.initialRoles || ['member']
          if (initialRoles.length !== 1 || initialRoles[0] !== 'member')
            if (!actor.permissions.includes('roles.manage'))
              throw new ApiError(403, 'role management permission required')
          const grants = await connection.query<{
            id: string
            permissions_json: string
          }>('SELECT id,permissions_json FROM roles WHERE id=ANY($1::text[])', [
            initialRoles,
          ])
          if (
            !initialRoles.length ||
            grants.length !== initialRoles.length ||
            grants.some((grant) =>
              json<string[]>(grant.permissions_json, []).some(
                (permission) => !actor.permissions.includes(permission),
              ),
            )
          )
            throw new ApiError(403, 'cannot grant permissions you do not hold')
        }
        if (options.bootstrap) {
          const [count] = await connection.query<{ count: string }>(
            'SELECT count(*)::text AS count FROM users',
          )
          if (Number(count?.count))
            throw new ApiError(409, 'instance already initialized')
        }
        if (options.requireVerification && email)
          verified = !!(await options.consumeCode?.(connection, email))
        if (!verified) return
        if (!explicit) {
          const existing = await connection.query(
            'SELECT id FROM users WHERE username=$1',
            [username],
          )
          if (existing.length)
            username = `${username.slice(0, 23)}-${tokenHash(email || id).slice(0, 8)}`
        }
        await connection.query(
          `INSERT INTO users(id,username,email,email_verified_at,display_name,password_hash,role,disabled,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,0,$8,$8)`,
          [
            id,
            username,
            email,
            email && (options.requireVerification || options.trustEmail)
              ? now
              : null,
            name,
            stored,
            initialRoles.includes('admin') ? 'admin' : 'member',
            now,
          ],
        )
        for (const selected of initialRoles)
          await connection.query(
            'INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)',
            [id, selected],
          )
        if (options.actor) {
          await connection.query(
            'UPDATE users SET reset_required=1 WHERE id=$1',
            [id],
          )
          await this.audit(
            options.actor.userId,
            'user.created',
            id,
            {},
            connection,
          )
        }
        if (options.bootstrap)
          await this.setSetting('registration_open', 'false', connection)
      })
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new ApiError(409, 'username or email is already in use')
      throw error
    }
    if (!verified)
      throw new ApiError(422, 'invalid or expired verification code')
    return this.getUser(id)
  }
  async changePassword(
    userId: string,
    stored: string,
    connection?: SqlConnection,
  ): Promise<void> {
    const change = async (conn: SqlConnection) => {
      const rows = await conn.query(
        'UPDATE users SET password_hash=$2,auth_version=auth_version+1,reset_required=0,updated_at=$3 WHERE id=$1 AND deleted_at IS NULL RETURNING id',
        [userId, stored, utcNow()],
      )
      if (!rows.length) throw new ApiError(404, 'user not found')
      await conn.query(
        'UPDATE auth_sessions SET revoked_at=$2 WHERE user_id=$1',
        [userId, utcNow()],
      )
      await conn.query('DELETE FROM recovery_codes WHERE user_id=$1', [userId])
    }
    if (connection) await change(connection)
    else {
      await this.db.transaction(change)
      await this.options.onAccountChanged?.(userId, 'credentials')
    }
  }
  async audit(
    actorId: string,
    action: string,
    targetId: string,
    detail: Row = {},
    connection: SqlConnection = this.db,
  ): Promise<void> {
    await connection.query(
      'INSERT INTO identity_audit(id,actor_id,action,target_id,created_at,detail_json) VALUES($1,$2,$3,$4,$5,$6)',
      [
        randomToken(18),
        actorId,
        action,
        targetId,
        utcNow(),
        JSON.stringify(detail),
      ],
    )
  }
  async currentActor(
    actor: Account,
    connection: SqlConnection,
    permission: string,
  ): Promise<Account> {
    const current = await this.getUser(actor.userId, connection)
    if (
      current.disabled ||
      current.deletedAt ||
      current.resetRequired ||
      current.authzVersion !== actor.authzVersion ||
      !current.permissions.includes(permission)
    )
      throw new ApiError(403, 'acting account authorization changed')
    return current
  }
  prepare(request: IncomingMessage, userId: string): void {
    if (request.headers['x-superdsh-agent-preparation'] !== 'deferred')
      this.options.onPrepareAgent?.(userId)
  }
}
