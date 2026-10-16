import type { IncomingMessage } from 'node:http'
import {
  ApiError,
  ApiRouter,
  bearer,
  integer,
  text,
  utcNow,
  type ApiContext,
  type Account,
} from '../http/api-router.ts'
import {
  IdentityService,
  displayName,
  emailAddress,
  equalSecret,
  randomToken,
  tokenHash,
  type Login,
  type Row,
} from './service.ts'
import { EmailVerification } from './email.ts'
import { registerOAuthRoutes } from './oauth.ts'
import { registerMobileLoginRoutes } from './mobile-login.ts'

export function publicOrigin(
  request: IncomingMessage,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.AGENT_SERVER_PUBLIC_ORIGIN?.trim()
  const encrypted = 'encrypted' in request.socket && request.socket.encrypted
  const candidate =
    configured ||
    `${encrypted ? 'https' : 'http'}://${request.headers.host || 'localhost'}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new ApiError(500, 'invalid public origin configuration')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new ApiError(500, 'invalid public origin configuration')
  // Forwarded headers are client-controlled unless a proxy has authenticated
  // them. A deployment behind TLS termination must set the canonical origin.
  return url.origin
}
function cookies(request: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    text(request.headers.cookie)
      .split(';')
      .map((part) => {
        const index = part.indexOf('=')
        return [part.slice(0, index).trim(), part.slice(index + 1)]
      }),
  )
}
export function checkCookieOrigin(request: IncomingMessage): void {
  const origin = request.headers.origin
  if (
    origin &&
    origin !== publicOrigin(request) &&
    !(process.env.AGENT_SERVER_CORS_ORIGINS || '').split(',').includes(origin)
  )
    throw new ApiError(403, 'untrusted cookie request origin')
}
function refreshCookie(
  context: ApiContext,
  token: string,
  clear = false,
): void {
  context.response.setHeader(
    'Set-Cookie',
    `superdsh_refresh=${token}; Path=/api/v2/auth; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 30 * 86400}${publicOrigin(context.request).startsWith('https:') ? '; Secure' : ''}`,
  )
}
export function userPayload(user: Account): Row {
  return { ...user, serverTime: utcNow() }
}
export function authPayload(
  context: ApiContext,
  identity: IdentityService,
  login: Login,
  native: boolean,
): Row {
  if (!native) refreshCookie(context, login.refreshToken)
  context.response.setHeader('Cache-Control', 'no-store')
  identity.prepare(context.request, login.user.userId)
  return {
    ...userPayload(login.user),
    accessToken: login.accessToken,
    refreshToken: native ? login.refreshToken : null,
    expiresIn: 900,
    tokenType: 'bearer',
  }
}
export function setupAllowed(
  identity: IdentityService,
  candidate: unknown,
): boolean {
  return (
    !!identity.options.setupToken &&
    equalSecret(identity.options.setupToken, text(candidate)) &&
    (!identity.options.setupTokenExpiresAt ||
      identity.options.setupTokenExpiresAt > utcNow())
  )
}

export function registerIdentityRoutes(
  router: ApiRouter,
  identity: IdentityService,
): void {
  const db = identity.db,
    email = new EmailVerification(identity)
  const countUsers = async () =>
    Number(
      (
        await db.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM users',
        )
      )[0]?.count || 0,
    )
  router.add(
    'GET',
    '/auth/config',
    async () => {
      const oauth = await identity.settingsObject('oauth_provider'),
        settings = await identity.settingsObject('email_verification'),
        needsBootstrap = !(await countUsers())
      const oauthEnabled = !!(
        oauth.enabled &&
        oauth.authorizeUrl &&
        oauth.clientId
      )
      return {
        emailVerificationRequired: settings.enabled === true,
        needsBootstrap,
        registrationOpen:
          (await identity.getSetting('registration_open')) === 'true',
        oauthRegistrationOpen:
          (await identity.getSetting('oauth_registration_open')) === 'true',
        oauthEnabled,
        oauthProviderLabel: oauthEnabled ? text(oauth.label, 'OAuth') : null,
        setupTokenExpiresAt: needsBootstrap
          ? identity.options.setupTokenExpiresAt || null
          : null,
        serverTime: utcNow(),
      }
    },
    { public: true },
  )
  router.add(
    'POST',
    '/auth/password-salt',
    async ({ body }) => {
      const row = await identity.loginRow(
        text(body.identifier) || text(body.email),
      )
      return {
        salt: row
          ? identity.crypto.passwordSalt(text(row.password_hash)) ||
            randomToken(16)
          : randomToken(16),
        serverTime: utcNow(),
      }
    },
    { public: true },
  )
  router.add(
    'POST',
    '/auth/login',
    async (context) => {
      const { body } = context
      const user = await identity.verifyLogin(
        text(body.identifier) || text(body.email),
        body.password,
        body.passwordVerifier,
      )
      if (!user) throw new ApiError(401, 'invalid credentials')
      return authPayload(
        context,
        identity,
        await identity.issueLogin(
          user.userId,
          text(body.clientName, 'Browser'),
        ),
        body.clientType === 'native',
      )
    },
    { public: true },
  )
  router.add(
    'POST',
    '/auth/register',
    async (context) => {
      const bootstrap = !(await countUsers())
      if (bootstrap && !setupAllowed(identity, context.body.setupToken))
        throw new ApiError(
          401,
          'invalid or expired setup token — find the current token in the server log',
        )
      if (
        !bootstrap &&
        (await identity.getSetting('registration_open')) !== 'true'
      )
        throw new ApiError(403, 'registration is closed')
      const settings = await identity.settingsObject('email_verification')
      const user = await identity.createUser(context.body, {
        role: bootstrap ? 'admin' : 'member',
        bootstrap,
        trustEmail: true,
        requireVerification: settings.enabled === true,
        consumeCode: (connection, address) =>
          email.consume(connection, address, 'register', '', context.body.code),
      })
      return authPayload(
        context,
        identity,
        await identity.issueLogin(
          user.userId,
          text(context.body.clientName, 'Browser'),
        ),
        context.body.clientType === 'native',
      )
    },
    { public: true },
  )
  router.add(
    'POST',
    '/auth/refresh',
    async (context) => {
      const native = !!context.body.refreshToken
      if (!native) checkCookieOrigin(context.request)
      const token =
        text(context.body.refreshToken) ||
        cookies(context.request).superdsh_refresh ||
        ''
      const login = token ? await identity.refreshLogin(token) : null
      if (!login) {
        refreshCookie(context, '', true)
        throw new ApiError(401, 'login session expired or revoked')
      }
      return authPayload(context, identity, login, native)
    },
    { public: true },
  )
  router.add(
    'POST',
    '/auth/logout',
    async (context) => {
      if (!context.body.refreshToken) checkCookieOrigin(context.request)
      const refresh =
        text(context.body.refreshToken) ||
        cookies(context.request).superdsh_refresh
      if (refresh) await identity.revokeLogin({ refresh })
      const user = await identity.authenticateToken(bearer(context.request)),
        claims = identity.crypto.userAccessClaims(bearer(context.request))
      if (user && claims?.sid)
        await identity.revokeLogin({
          userId: user.userId,
          sessionId: claims.sid,
        })
      refreshCookie(context, '', true)
    },
    { public: true },
  )
  router.add('POST', '/auth/logout-all', async (context) => {
    await identity.revokeLogin({ userId: (await context.user()).userId })
    refreshCookie(context, '', true)
  })
  router.add('GET', '/auth/me', async (context) => {
    const user = await context.user()
    identity.prepare(context.request, user.userId)
    return userPayload(user)
  })
  router.add('PUT', '/auth/me/profile', async (context) => {
    const user = await context.user()
    await db.query(
      'UPDATE users SET display_name=$2,updated_at=$3 WHERE id=$1',
      [user.userId, displayName(context.body.displayName), utcNow()],
    )
    return userPayload(await identity.getUser(user.userId))
  })
  router.add('PUT', '/auth/me/username', async (context) => {
    const user = await context.user(),
      username = text(context.body.username).trim().toLowerCase()
    if (!/^[a-z0-9_-]{3,32}$/.test(username))
      throw new ApiError(
        422,
        'username must be 3-32 lowercase letters, digits, hyphen or underscore',
      )
    try {
      await db.query('UPDATE users SET username=$2,updated_at=$3 WHERE id=$1', [
        user.userId,
        username,
        utcNow(),
      ])
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new ApiError(409, 'username or email is already in use')
      throw error
    }
    return userPayload(await identity.getUser(user.userId))
  })
  router.add('PUT', '/auth/me/avatar', async (context) => {
    const user = await context.user(),
      avatar = text(context.body.avatar).trim()
    if (avatar.length > 256 * 1024)
      throw new ApiError(413, 'avatar exceeds 256KB limit')
    if (
      !/^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(
        avatar,
      )
    )
      throw new ApiError(422, 'invalid avatar image')
    await db.query('UPDATE users SET avatar=$2,updated_at=$3 WHERE id=$1', [
      user.userId,
      avatar,
      utcNow(),
    ])
    return userPayload(await identity.getUser(user.userId))
  })
  router.add('DELETE', '/auth/me/avatar', async (context) => {
    const user = await context.user()
    await db.query('UPDATE users SET avatar=NULL,updated_at=$2 WHERE id=$1', [
      user.userId,
      utcNow(),
    ])
    return userPayload(await identity.getUser(user.userId))
  })
  router.add('POST', '/auth/change-password', async (context) => {
    await identity.changePassword(
      (await context.user()).userId,
      await identity.passwordHash(context.body, 'new'),
    )
  })
  router.add('GET', '/auth/sessions', async (context) => {
    const user = await context.user(),
      sid = identity.crypto.userAccessClaims(bearer(context.request))?.sid
    const page = integer(context.url.searchParams.get('page'), 1, 1),
      pageSize = integer(context.url.searchParams.get('pageSize'), 200, 1, 200),
      search = text(context.url.searchParams.get('search')).toLowerCase()
    const where =
        'user_id=$1 AND revoked_at IS NULL AND expires_at>$2 AND position($3 in lower(client_name))>0',
      values = [user.userId, utcNow(), search]
    const total = Number(
      (
        await db.query<Row>(
          `SELECT count(*)::text AS count FROM auth_sessions WHERE ${where}`,
          values,
        )
      )[0]?.count,
    )
    const rows = await db.query<Row>(
      `SELECT id,client_name,created_at,last_seen_at,expires_at FROM auth_sessions WHERE ${where} ORDER BY created_at DESC,id LIMIT $4 OFFSET $5`,
      [...values, pageSize, (page - 1) * pageSize],
    )
    return {
      sessions: rows.map((row) => ({
        id: row.id,
        clientName: row.client_name,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        expiresAt: row.expires_at,
        current: row.id === sid,
      })),
      total,
      page,
      pageSize,
    }
  })
  router.add('DELETE', '/auth/sessions/{session_id}', async (context) => {
    await identity.revokeLogin({
      userId: (await context.user()).userId,
      sessionId: context.params.session_id,
    })
  })
  router.add('POST', '/auth/recovery-codes', async (context) => {
    const user = await context.user(),
      codes = Array.from({ length: 8 }, () => randomToken(24))
    await db.transaction(async (connection) => {
      await connection.query('DELETE FROM recovery_codes WHERE user_id=$1', [
        user.userId,
      ])
      for (const code of codes)
        await connection.query(
          'INSERT INTO recovery_codes(code_hash,user_id,created_at) VALUES($1,$2,$3)',
          [tokenHash(code), user.userId, utcNow()],
        )
    })
    return { codes }
  })
  router.add(
    'POST',
    '/auth/recovery/reset',
    async (context) => {
      const row = await identity.loginRow(text(context.body.identifier)),
        stored = await identity.passwordHash(context.body, 'new')
      if (!row) throw new ApiError(401, 'invalid recovery credentials')
      await db.transaction(async (connection) => {
        const consumed = await connection.query(
          'UPDATE recovery_codes SET consumed_at=$3 WHERE user_id=$1 AND code_hash=$2 AND consumed_at IS NULL RETURNING code_hash',
          [row.id, tokenHash(text(context.body.recoveryCode)), utcNow()],
        )
        if (!consumed.length)
          throw new ApiError(401, 'invalid recovery credentials')
        await identity.changePassword(text(row.id), stored, connection)
      })
      await identity.options.onAccountChanged?.(text(row.id), 'credentials')
    },
    { public: true },
  )
  router.add(
    'POST',
    '/auth/email-code',
    async (context) => {
      const purpose = text(context.body.purpose),
        address = emailAddress(context.body.email)
      const current = bearer(context.request) ? await context.user() : null
      if (purpose === 'bind' && !current)
        throw new ApiError(401, 'authentication required')
      if (purpose === 'register') {
        const pending = identity.crypto.verifySignedToken(
          'oauth_pending',
          text(context.body.pendingToken),
        )
        const allowed =
          (await identity.getSetting('registration_open')) === 'true' ||
          current?.role === 'admin' ||
          (!!pending &&
            (await identity.getSetting('oauth_registration_open')) ===
              'true') ||
          (!(await countUsers()) &&
            setupAllowed(identity, context.body.setupToken))
        if (!allowed) throw new ApiError(403, 'registration is closed')
      }
      const [existing] = await db.query<Row>(
        'SELECT * FROM users WHERE email=$1',
        [address],
      )
      if (
        purpose === 'reset' &&
        (!existing ||
          existing.disabled ||
          existing.deleted_at ||
          !existing.email_verified_at)
      )
        return { serverTime: utcNow() }
      if (
        purpose !== 'reset' &&
        existing &&
        (purpose !== 'bind' || existing.id !== current?.userId)
      )
        throw new ApiError(409, 'email is already in use')
      await email.issue(
        address,
        purpose,
        purpose === 'reset'
          ? text(existing?.id)
          : purpose === 'bind'
            ? current!.userId
            : '',
      )
      return { serverTime: utcNow() }
    },
    { public: true },
  )
  router.add('PUT', '/auth/me/email', async (context) => {
    const user = await context.user(),
      address = emailAddress(context.body.email),
      settings = await identity.settingsObject('email_verification')
    let valid = true
    try {
      await db.transaction(async (connection) => {
        if (settings.enabled)
          valid = await email.consume(
            connection,
            address,
            'bind',
            user.userId,
            context.body.code,
          )
        if (valid)
          await connection.query(
            'UPDATE users SET email=$2,email_verified_at=$3,updated_at=$3 WHERE id=$1',
            [user.userId, address, utcNow()],
          )
      })
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new ApiError(409, 'email is already in use')
      throw error
    }
    if (!valid) throw new ApiError(422, 'invalid or expired verification code')
    return userPayload(await identity.getUser(user.userId))
  })
  router.add(
    'POST',
    '/auth/recovery/reset-email',
    async (context) => {
      const address = emailAddress(context.body.email),
        stored = await identity.passwordHash(context.body, 'new')
      const row = await identity.loginRow(address)
      if (!row) throw new ApiError(401, 'invalid recovery credentials')
      let valid = false
      await db.transaction(async (connection) => {
        valid = await email.consume(
          connection,
          address,
          'reset',
          text(row.id),
          context.body.code,
        )
        if (valid)
          await identity.changePassword(text(row.id), stored, connection)
      })
      if (!valid) throw new ApiError(401, 'invalid recovery credentials')
      await identity.options.onAccountChanged?.(text(row.id), 'credentials')
    },
    { public: true },
  )
  registerOAuthRoutes(router, identity, email)
  registerMobileLoginRoutes(router, identity)
}
