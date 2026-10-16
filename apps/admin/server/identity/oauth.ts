import { createHash } from 'node:crypto'
import {
  ApiError,
  ApiRouter,
  bearer,
  object,
  requiredText,
  text,
  utcNow,
  type Account,
  type ApiContext,
} from '../http/api-router.ts'
import { IdentityService, randomToken, tokenHash, type Row } from './service.ts'
import { EmailVerification } from './email.ts'
import { authPayload, publicOrigin } from './routes.ts'

export function authorizationReference(
  identity: IdentityService,
  token: string,
): { auth_user_id: string; auth_session_id: string; auth_version: number } {
  const claims = identity.crypto.userAccessClaims(token)
  if (!claims?.sid || claims.ver === undefined)
    throw new ApiError(401, 'authentication required')
  return {
    auth_user_id: claims.sub,
    auth_session_id: claims.sid,
    auth_version: claims.ver,
  }
}
export async function referenceUser(
  identity: IdentityService,
  reference: Row | null,
): Promise<Account | null> {
  if (
    !reference ||
    typeof reference.auth_user_id !== 'string' ||
    typeof reference.auth_session_id !== 'string' ||
    typeof reference.auth_version !== 'number'
  )
    return null
  return identity.authenticateToken(
    identity.crypto.createUserAccessToken(reference.auth_user_id, {
      sessionId: reference.auth_session_id,
      authVersion: reference.auth_version,
    }),
  )
}
export function allowedRedirect(client: string, uri: string): boolean {
  if (['superdsh-desktop', 'agents-anywhere-dsh-plugin'].includes(client)) {
    const match =
      /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/oauth\/callback$/.exec(uri)
    return !!match && Number(match[1]) >= 1024 && Number(match[1]) <= 65535
  }
  return (
    (client === 'agents-anywhere-mobile' &&
      uri === 'agents-anywhere://oauth/callback') ||
    (client === 'agents-anywhere-desktop' &&
      uri === 'agents-anywhere-desktop://oauth/callback')
  )
}
function redirect(context: ApiContext, url: string): void {
  context.response.writeHead(302, {
    Location: url,
    'Cache-Control': 'no-store',
  })
  context.response.end()
}
function returnAddress(context: ApiContext, value: unknown): string {
  const fallback = `${publicOrigin(context.request)}/`
  if (!value) return fallback
  const url = new URL(text(value), fallback)
  const allowed = new Set([
    publicOrigin(context.request),
    ...(process.env.AGENT_SERVER_CORS_ORIGINS || '').split(','),
  ])
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !allowed.has(url.origin) ||
    url.username ||
    url.password
  )
    throw new ApiError(422, 'OAuth return address is not allowed')
  return url.toString()
}

export function registerOAuthRoutes(
  router: ApiRouter,
  identity: IdentityService,
  email: EmailVerification,
): void {
  const db = identity.db
  router.add(
    'GET',
    '/.well-known/oauth-authorization-server',
    ({ request }) => {
      const issuer = publicOrigin(request)
      return {
        issuer,
        authorization_endpoint: `${issuer}/api/v2/oauth/authorize`,
        token_endpoint: `${issuer}/api/v2/oauth/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
      }
    },
    { public: true },
  )
  async function authorize(context: ApiContext, body: Row): Promise<string> {
    const user = await context.user()
    if (user.resetRequired) throw new ApiError(403, 'password change required')
    if (body.response_type !== 'code')
      throw new ApiError(422, 'response_type must be code')
    const clientId = requiredText(body.client_id, 'client_id'),
      uri = requiredText(body.redirect_uri, 'redirect_uri'),
      challenge = requiredText(body.code_challenge, 'code_challenge')
    if (!allowedRedirect(clientId, uri))
      throw new ApiError(422, 'redirect uri is not allowed')
    if (
      text(body.code_challenge_method, 'S256') !== 'S256' ||
      !/^[A-Za-z0-9_-]{43}$/.test(challenge)
    )
      throw new ApiError(422, 'code challenge method must be S256')
    const code = randomToken(32),
      now = utcNow()
    await db.query(
      `INSERT INTO oauth_authorization_codes(code_hash,client_id,user_id,redirect_uri,scope,code_challenge,code_challenge_method,expires_at,created_at)
      VALUES($1,$2,$3,$4,$5,$6,'S256',$7,$8)`,
      [
        tokenHash(code),
        clientId,
        user.userId,
        uri,
        text(body.scope),
        challenge,
        new Date(Date.now() + 300000).toISOString(),
        now,
      ],
    )
    const grant = identity.crypto.createSignedToken(
      'oauth_grant',
      { code, ...authorizationReference(identity, bearer(context.request)) },
      300,
    )
    const params = new URLSearchParams({ code: grant })
    if (typeof body.state === 'string') params.set('state', body.state)
    return `${uri}?${params}`
  }
  router.add('GET', '/oauth/authorize', async (context) => {
    redirect(
      context,
      await authorize(context, Object.fromEntries(context.url.searchParams)),
    )
  })
  router.add('POST', '/oauth/authorize', async (context) => ({
    redirectUrl: await authorize(context, context.body),
    serverTime: utcNow(),
  }))
  router.add(
    'POST',
    '/oauth/token',
    async (context) => {
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of context.request) {
        const data = Buffer.from(chunk)
        bytes += data.length
        if (bytes > 16384) throw new ApiError(413, 'request too large')
        chunks.push(data)
      }
      const body = Object.fromEntries(
        new URLSearchParams(Buffer.concat(chunks).toString('utf8')),
      )
      if (body.grant_type !== 'authorization_code')
        throw new ApiError(422, 'grant_type must be authorization_code')
      if (!allowedRedirect(body.client_id || '', body.redirect_uri || ''))
        throw new ApiError(422, 'redirect uri is not allowed')
      const grant = identity.crypto.verifySignedToken(
          'oauth_grant',
          body.code || '',
        ),
        issuer = await referenceUser(identity, grant)
      if (!issuer || issuer.resetRequired)
        throw new ApiError(400, 'authorization grant expired or revoked')
      const verifier = body.code_verifier || ''
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))
        throw new ApiError(400, 'invalid code verifier')
      const result = await db.transaction(async (connection) => {
        const [row] = await connection.query<Row>(
          'SELECT * FROM oauth_authorization_codes WHERE code_hash=$1 AND client_id=$2 FOR UPDATE',
          [tokenHash(text(grant?.code)), body.client_id],
        )
        if (
          !row ||
          row.consumed_at ||
          text(row.expires_at) < utcNow() ||
          row.redirect_uri !== body.redirect_uri ||
          row.user_id !== issuer.userId ||
          row.code_challenge !==
            createHash('sha256').update(verifier).digest('base64url')
        )
          throw new ApiError(400, 'invalid authorization code or verifier')
        await connection.query(
          'UPDATE oauth_authorization_codes SET consumed_at=$2 WHERE code_hash=$1',
          [row.code_hash, utcNow()],
        )
        return row
      })
      const login = await identity.issueLogin(issuer.userId, body.client_id)
      identity.prepare(context.request, issuer.userId)
      context.response.setHeader('Pragma', 'no-cache')
      return {
        access_token: login.accessToken,
        refresh_token: login.refreshToken,
        token_type: 'bearer',
        expires_in: 900,
        scope: result.scope,
      }
    },
    { public: true, rawBody: true },
  )
  router.add(
    'GET',
    '/auth/oauth/start',
    async (context) => {
      const config = await identity.settingsObject('oauth_provider')
      if (!config.enabled || !config.authorizeUrl || !config.clientId)
        throw new ApiError(404, 'oauth is not configured')
      const target = returnAddress(
        context,
        context.url.searchParams.get('returnTo'),
      )
      const origin = new URL(target).origin,
        state = identity.crypto.createSignedToken(
          'oauth_state',
          {
            provider: text(config.provider, 'oidc'),
            returnTo: target,
            nonce: randomToken(),
          },
          600,
        )
      const url = new URL(text(config.authorizeUrl))
      for (const [key, value] of Object.entries({
        client_id: text(config.clientId),
        redirect_uri: `${origin}/api/v2/auth/oauth/callback`,
        response_type: 'code',
        scope: text(config.scopes, 'openid profile email'),
        state,
      }))
        url.searchParams.set(key, value)
      context.response.setHeader(
        'Set-Cookie',
        `superdsh_oauth_state=${tokenHash(state)}; Path=/api/v2/auth/oauth; HttpOnly; SameSite=Lax; Max-Age=600${origin.startsWith('https:') ? '; Secure' : ''}`,
      )
      return { authorizeUrl: url.toString(), serverTime: utcNow() }
    },
    { public: true },
  )
  router.add(
    'GET',
    '/auth/oauth/callback',
    async (context) => {
      const config = await identity.settingsObject('oauth_provider'),
        state = text(context.url.searchParams.get('state')),
        grant = identity.crypto.verifySignedToken('oauth_state', state)
      const target = new URL(returnAddress(context, grant?.returnTo))
      const fail = (message: string) => {
        target.searchParams.set('oauth_error', message)
        redirect(context, target.toString())
      }
      if (
        !grant ||
        grant.provider !== text(config.provider, 'oidc') ||
        !text(context.request.headers.cookie)
          .split(';')
          .some(
            (part) =>
              part.trim() === `superdsh_oauth_state=${tokenHash(state)}`,
          )
      ) {
        fail('invalid oauth state')
        return
      }
      context.response.setHeader(
        'Set-Cookie',
        'superdsh_oauth_state=; Path=/api/v2/auth/oauth; HttpOnly; SameSite=Lax; Max-Age=0',
      )
      if (context.url.searchParams.has('error')) {
        fail(text(context.url.searchParams.get('error')))
        return
      }
      if (
        !config.enabled ||
        !config.tokenUrl ||
        !config.userInfoUrl ||
        !config.clientSecret ||
        !context.url.searchParams.get('code')
      ) {
        fail('oauth configuration or callback is incomplete')
        return
      }
      try {
        const tokenResponse = await fetch(text(config.tokenUrl), {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: context.url.searchParams.get('code')!,
            redirect_uri: `${target.origin}/api/v2/auth/oauth/callback`,
            client_id: text(config.clientId),
            client_secret: text(config.clientSecret),
          }),
          signal: AbortSignal.timeout(10000),
          redirect: 'error',
        })
        const token = object(await tokenResponse.json())
        if (!tokenResponse.ok || typeof token.access_token !== 'string')
          throw new Error('provider rejected authorization')
        const profileResponse = await fetch(text(config.userInfoUrl), {
          headers: {
            Authorization: `Bearer ${token.access_token}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(10000),
          redirect: 'error',
        })
        if (!profileResponse.ok) throw new Error('provider rejected profile')
        const claims = object(await profileResponse.json()),
          subject = requiredText(
            claims[text(config.subjectClaim, 'sub')],
            'oauth subject',
          ),
          provider = text(config.provider, 'oidc')
        const address = text(claims[text(config.emailClaim, 'email')]),
          name = text(claims[text(config.nameClaim, 'name')])
        const [bound] = await db.query<Row>(
          'SELECT u.* FROM users u JOIN oauth_accounts a ON a.user_id=u.id WHERE a.provider=$1 AND a.subject=$2',
          [provider, subject],
        )
        const [existing] = address
          ? await db.query<Row>('SELECT id FROM users WHERE email=$1', [
              address.toLowerCase(),
            ])
          : []
        const pending = identity.crypto.createSignedToken(
          'oauth_pending',
          {
            provider,
            providerLabel: text(config.label, 'OAuth'),
            subject,
            suggestedUserId: text(
              claims[text(config.usernameClaim, 'preferred_username')],
              'user',
            ),
            email: address || null,
            displayName: name || null,
          },
          600,
        )
        for (const [key, value] of Object.entries({
          oauth_status: bound
            ? 'authenticated'
            : existing
              ? 'needs_password'
              : 'needs_registration',
          oauth_pending: pending,
          oauth_email: bound ? text(bound.email) : address,
          oauth_display_name: bound ? text(bound.display_name) : name,
        }))
          target.searchParams.set(key, value)
        redirect(context, target.toString())
      } catch {
        fail(
          'OAuth provider request failed; check provider configuration and retry',
        )
      }
    },
    { public: true },
  )
  router.add(
    'POST',
    '/auth/oauth/finalize',
    async (context) => {
      const pending = identity.crypto.verifySignedToken(
        'oauth_pending',
        text(context.body.pendingToken),
      )
      if (
        !pending ||
        typeof pending.provider !== 'string' ||
        typeof pending.subject !== 'string'
      )
        throw new ApiError(401, 'oauth session expired')
      const [bound] = await db.query<Row>(
        'SELECT user_id FROM oauth_accounts WHERE provider=$1 AND subject=$2',
        [pending.provider, pending.subject],
      )
      let user: Account
      if (bound) user = await identity.getUser(text(bound.user_id))
      else {
        const address = text(context.body.email).trim().toLowerCase(),
          [existing] = await db.query<Row>(
            'SELECT id FROM users WHERE email=$1',
            [address],
          )
        if (existing) {
          const verified = await identity.verifyLogin(
            address,
            context.body.password,
            context.body.passwordVerifier,
          )
          if (!verified)
            throw new ApiError(401, 'password is required to link this account')
          user = verified
        } else {
          if ((await identity.getSetting('oauth_registration_open')) !== 'true')
            throw new ApiError(403, 'oauth registration is closed')
          const settings = await identity.settingsObject('email_verification')
          user = await identity.createUser(
            {
              ...context.body,
              ...(context.body.setPassword
                ? {}
                : { password: randomToken(32), passwordVerifier: undefined }),
            },
            {
              trustEmail: true,
              requireVerification: settings.enabled === true,
              consumeCode: (connection, mail) =>
                email.consume(
                  connection,
                  mail,
                  'register',
                  '',
                  context.body.code,
                ),
            },
          )
        }
        try {
          await db.query(
            'INSERT INTO oauth_accounts(provider,subject,user_id,email,display_name,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)',
            [
              pending.provider,
              pending.subject,
              user.userId,
              pending.email,
              pending.displayName,
              utcNow(),
            ],
          )
        } catch (error) {
          if ((error as { code?: string }).code === '23505')
            throw new ApiError(
              409,
              'OAuth identity was already linked; retry login',
            )
          throw error
        }
      }
      return {
        auth: authPayload(
          context,
          identity,
          await identity.issueLogin(user.userId),
          false,
        ),
        serverTime: utcNow(),
      }
    },
    { public: true },
  )
}
