import {
  ApiError,
  ApiRouter,
  bearer,
  text,
  utcNow,
} from '../http/api-router.ts'
import { IdentityService, randomToken, tokenHash, type Row } from './service.ts'
import { authPayload } from './routes.ts'
import { authorizationReference, referenceUser } from './oauth.ts'

function status(row: Row): Row {
  const now = utcNow()
  return {
    status: row.consumed_at
      ? 'consumed'
      : text(row.expires_at) < now
        ? 'expired'
        : row.rejected_at
          ? 'rejected'
          : row.approved_at
            ? 'approved'
            : row.requested_at
              ? 'pending_web_confirm'
              : 'pending_scan',
    userId: row.user_id,
    deviceName: row.device_name,
    expiresAt: row.expires_at,
    requestedAt: row.requested_at,
    approvedAt: row.approved_at,
    serverTime: now,
  }
}
export function registerMobileLoginRoutes(
  router: ApiRouter,
  identity: IdentityService,
): void {
  const db = identity.db
  router.add('POST', '/auth/mobile-login/qr', async (context) => {
    const user = await context.user()
    if (user.resetRequired) throw new ApiError(403, 'password change required')
    const token = identity.crypto.createSignedToken(
        'mobile_login',
        {
          sub: user.userId,
          aud: 'agents-anywhere-mobile',
          nonce: randomToken(12),
          ...authorizationReference(identity, bearer(context.request)),
        },
        120,
      ),
      expiresAt = new Date(Date.now() + 120000).toISOString()
    await db.query(
      'INSERT INTO mobile_login_tokens(token_hash,user_id,expires_at,created_at) VALUES($1,$2,$3,$4)',
      [tokenHash(token), user.userId, expiresAt, utcNow()],
    )
    return {
      userId: user.userId,
      loginToken: token,
      expiresAt,
      serverTime: utcNow(),
    }
  })
  for (const action of ['request', 'status', 'confirm', 'exchange'])
    router.add(
      'POST',
      `/auth/mobile-login/${action}`,
      async (context) => {
        const token = text(context.body.loginToken),
          grant = identity.crypto.verifySignedToken('mobile_login', token),
          issuer = await referenceUser(identity, grant)
        if (!issuer || issuer.resetRequired || issuer.userId !== grant?.sub)
          throw new ApiError(401, 'invalid or expired mobile login token')
        if (
          action !== 'status' &&
          action !== 'confirm' &&
          context.body.userId !== issuer.userId
        )
          throw new ApiError(401, 'invalid or expired mobile login token')
        if (
          action === 'confirm' &&
          (await context.user()).userId !== issuer.userId
        )
          throw new ApiError(401, 'invalid or expired mobile login token')
        const row = await db.transaction(async (connection) => {
          let [record] = await connection.query<Row>(
            'SELECT * FROM mobile_login_tokens WHERE token_hash=$1 AND user_id=$2 FOR UPDATE',
            [tokenHash(token), issuer.userId],
          )
          if (!record) throw new ApiError(404, 'mobile login token not found')
          if (action !== 'status') {
            if (record.consumed_at || text(record.expires_at) < utcNow())
              throw new ApiError(401, 'invalid or expired mobile login token')
            if (action === 'request' && !record.rejected_at)
              [record] = await connection.query<Row>(
                'UPDATE mobile_login_tokens SET device_name=$2,requested_at=COALESCE(requested_at,$3) WHERE token_hash=$1 RETURNING *',
                [
                  tokenHash(token),
                  text(context.body.deviceName).slice(0, 80) || null,
                  utcNow(),
                ],
              )
            if (action === 'confirm' && record?.requested_at)
              [record] = await connection.query<Row>(
                'UPDATE mobile_login_tokens SET approved_at=$2,rejected_at=$3 WHERE token_hash=$1 RETURNING *',
                [
                  tokenHash(token),
                  context.body.approved === true ? utcNow() : null,
                  context.body.approved === true ? null : utcNow(),
                ],
              )
            if (action === 'exchange') {
              if (!record?.approved_at || record.rejected_at)
                throw new ApiError(401, 'mobile login requires approval')
              await connection.query(
                'UPDATE mobile_login_tokens SET consumed_at=$2 WHERE token_hash=$1',
                [tokenHash(token), utcNow()],
              )
            }
          }
          return record!
        })
        if (action !== 'exchange') return status(row)
        const login = await identity.issueLogin(issuer.userId, 'Mobile')
        return {
          auth: authPayload(context, identity, login, true),
          refreshToken: login.refreshToken,
          expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
          serverTime: utcNow(),
        }
      },
      { public: action !== 'confirm' },
    )
}
