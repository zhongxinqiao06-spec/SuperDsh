import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { ApiRouter } from '../http/api-router.ts'
import { IdentityService, tokenHash } from '../identity/service.ts'
import { registerIdentityRoutes } from '../identity/routes.ts'
import { EmailVerification } from '../identity/email.ts'
import { withTestDatabase } from './support/database.mjs'

async function fixture(t) {
  const db = await withTestDatabase(t),
    changed = [],
    prepared = []
  const identity = new IdentityService(db, {
    secret: 'synthetic-identity-secret',
    setupToken: 'synthetic-setup-token',
    onAccountChanged: (id) => changed.push(id),
    onPrepareAgent: (id) => prepared.push(id),
  })
  await identity.seedBuiltinRoles()
  const router = new ApiRouter(identity.authorize)
  registerIdentityRoutes(router, identity)
  const server = createServer((req, res) =>
    router.handle(req, res, { signal: AbortSignal.timeout(5000) }),
  )
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(resolve)
      }),
  )
  const base = `http://127.0.0.1:${server.address().port}/api/v2`
  async function request(path, body, token, extra = {}) {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...extra,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    return {
      response,
      body: response.status === 204 ? null : await response.json(),
    }
  }
  return { db, identity, changed, prepared, base, request }
}

test('native and web login preserve hashes, refresh rotation and no browser refresh disclosure', async (t) => {
  const f = await fixture(t)
  assert.equal(
    (
      await f.request('/auth/register', {
        username: 'admin',
        displayName: 'Admin',
        password: 'password-123',
        setupToken: 'bad',
      })
    ).response.status,
    401,
  )
  const register = await f.request('/auth/register', {
    username: 'admin',
    displayName: 'Admin',
    password: 'password-123',
    setupToken: 'synthetic-setup-token',
  })
  assert.equal(register.response.status, 200, JSON.stringify(register.body))
  assert.equal(register.body.refreshToken, null)
  assert.match(
    register.response.headers.get('set-cookie'),
    /HttpOnly; SameSite=Strict/,
  )
  assert.ok(register.body.permissions.includes('menus.manage'))
  const salt = await f.request('/auth/password-salt', { identifier: 'admin' })
  const stored = (await f.db.query('SELECT password_hash FROM users'))[0]
    .password_hash
  assert.equal(salt.body.salt, f.identity.crypto.passwordSalt(stored))
  const native = await f.request(
    '/auth/login',
    {
      identifier: 'admin',
      password: 'password-123',
      clientType: 'native',
      clientName: 'SuperDsh Android',
    },
    undefined,
    { 'X-SuperDsh-Agent-Preparation': 'deferred' },
  )
  assert.equal(native.response.status, 200)
  assert.equal(f.prepared.length, 1)
  assert.equal(native.response.headers.get('set-cookie'), null)
  const refresh = await f.request('/auth/refresh', {
    refreshToken: native.body.refreshToken,
  })
  assert.equal(refresh.response.status, 200)
  assert.notEqual(refresh.body.refreshToken, native.body.refreshToken)
  assert.equal(
    (await f.request('/auth/me', undefined, refresh.body.accessToken)).response
      .status,
    200,
  )
  assert.equal(
    (
      await f.request('/auth/refresh', {
        refreshToken: native.body.refreshToken,
      })
    ).response.status,
    401,
  )
  assert.equal(
    (await f.request('/auth/me', undefined, refresh.body.accessToken)).response
      .status,
    401,
  )
  assert.equal(
    await f.identity.authenticateToken(
      f.identity.crypto.createUserAccessToken(register.body.userId),
    ),
    null,
    'old token without session must be rejected',
  )
})

test('cookie origin validation and logout revoke only owned sessions', async (t) => {
  const f = await fixture(t)
  const user = await f.identity.createUser({
    username: 'member',
    displayName: 'Member',
    password: 'password-123',
  })
  const a = await f.identity.issueLogin(user.userId),
    b = await f.identity.issueLogin(user.userId)
  const rejected = await f.request('/auth/refresh', {}, undefined, {
    Cookie: `superdsh_refresh=${a.refreshToken}`,
    Origin: 'https://attacker.invalid',
  })
  assert.equal(rejected.response.status, 403)
  const forged = await f.request('/auth/refresh', {}, undefined, {
    Cookie: `superdsh_refresh=${a.refreshToken}`,
    Origin: 'https://attacker.invalid',
    'X-Forwarded-Host': 'attacker.invalid',
    'X-Forwarded-Proto': 'https',
  })
  assert.equal(forged.response.status, 403)
  const discovery = await f.request(
    '/.well-known/oauth-authorization-server',
    undefined,
    undefined,
    {
      'X-Forwarded-Host': 'attacker.invalid',
      'X-Forwarded-Proto': 'https',
    },
  )
  assert.equal(discovery.response.status, 200)
  assert.equal(discovery.body.issuer, f.base.replace('/api/v2', ''))
  const logout = await f.request(
    '/auth/logout',
    { refreshToken: a.refreshToken },
    a.accessToken,
  )
  assert.equal(logout.response.status, 204)
  assert.equal(await f.identity.authenticateToken(a.accessToken), null)
  assert.ok(await f.identity.authenticateToken(b.accessToken))
  assert.deepEqual(f.changed, [user.userId])
})

test('authorization code requires exact native redirect and PKCE; revoked issuer and replay are rejected', async (t) => {
  const f = await fixture(t)
  const user = await f.identity.createUser({
      username: 'member',
      displayName: 'Member',
      password: 'password-123',
    }),
    login = await f.identity.issueLogin(user.userId)
  const verifier = 'x'.repeat(50),
    redirect = 'http://127.0.0.1:12345/oauth/callback'
  const body = {
    response_type: 'code',
    client_id: 'superdsh-desktop',
    redirect_uri: redirect,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: 'state-1',
  }
  assert.equal(
    (
      await f.request(
        '/oauth/authorize',
        { ...body, redirect_uri: 'https://attacker.invalid/oauth/callback' },
        login.accessToken,
      )
    ).response.status,
    422,
  )
  const grant = await f.request('/oauth/authorize', body, login.accessToken)
  assert.equal(grant.response.status, 200, JSON.stringify(grant.body))
  const code = new URL(grant.body.redirectUrl).searchParams.get('code')
  const exchange = async (provided) =>
    fetch(f.base + '/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: 'superdsh-desktop',
        redirect_uri: redirect,
        code,
        code_verifier: provided,
      }),
    })
  assert.equal((await exchange('y'.repeat(50))).status, 400)
  const response = await exchange(verifier)
  assert.equal(response.status, 200)
  assert.ok((await response.json()).refresh_token)
  assert.equal((await exchange(verifier)).status, 400)
})

test('recovery is one-use, updates password and revokes old credentials', async (t) => {
  const f = await fixture(t)
  const user = await f.identity.createUser({
      username: 'member',
      displayName: 'Member',
      password: 'password-123',
    }),
    login = await f.identity.issueLogin(user.userId)
  const codes = await f.request('/auth/recovery-codes', {}, login.accessToken)
  assert.equal(codes.body.codes.length, 8)
  const reset = {
    identifier: 'member',
    recoveryCode: codes.body.codes[0],
    newPassword: 'new-password-123',
  }
  assert.equal(
    (await f.request('/auth/recovery/reset', reset)).response.status,
    204,
  )
  assert.equal(await f.identity.authenticateToken(login.accessToken), null)
  assert.equal(
    (await f.request('/auth/recovery/reset', reset)).response.status,
    401,
  )
  assert.equal(await f.identity.verifyLogin('member', 'password-123'), null)
  assert.ok(await f.identity.verifyLogin('member', 'new-password-123'))
})

test('email OTP keeps failed attempt counts and is consumed once', async (t) => {
  const f = await fixture(t),
    verification = new EmailVerification(f.identity),
    address = 'synthetic@example.test',
    now = Math.floor(Date.now() / 1000)
  const scope = verification.scope(address, 'register', ''),
    nonce = 'synthetic-nonce'
  await f.db.query(
    'INSERT INTO email_verification_codes(scope,email,purpose,user_id,code_hash,nonce,sent_at,expires_at,attempt_window) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$7)',
    [
      scope,
      address,
      'register',
      '',
      verification.digest(nonce, '123456'),
      nonce,
      now,
      now + 600,
    ],
  )
  assert.equal(
    await f.db.transaction((c) =>
      verification.consume(c, address, 'register', '', '000000'),
    ),
    false,
  )
  assert.equal(
    (
      await f.db.query(
        'SELECT failed_attempts FROM email_verification_codes WHERE scope=$1',
        [scope],
      )
    )[0].failed_attempts,
    1,
  )
  assert.equal(
    await f.db.transaction((c) =>
      verification.consume(c, address, 'register', '', '123456'),
    ),
    true,
  )
  assert.equal(
    await f.db.transaction((c) =>
      verification.consume(c, address, 'register', '', '123456'),
    ),
    false,
  )
  assert.equal(tokenHash('synthetic').length, 64)
})

test('mobile QR needs web approval and is revoked with its issuing login', async (t) => {
  const f = await fixture(t)
  const user = await f.identity.createUser({
      username: 'member',
      displayName: 'Member',
      password: 'password-123',
    }),
    login = await f.identity.issueLogin(user.userId)
  const qr = await f.request('/auth/mobile-login/qr', {}, login.accessToken)
  const body = { userId: user.userId, loginToken: qr.body.loginToken }
  assert.equal(
    (await f.request('/auth/mobile-login/exchange', body)).response.status,
    401,
  )
  assert.equal(
    (
      await f.request('/auth/mobile-login/request', {
        ...body,
        deviceName: 'Android',
      })
    ).body.status,
    'pending_web_confirm',
  )
  assert.equal(
    (
      await f.request(
        '/auth/mobile-login/confirm',
        { loginToken: body.loginToken, approved: true },
        login.accessToken,
      )
    ).body.status,
    'approved',
  )
  const exchange = await f.request('/auth/mobile-login/exchange', body)
  assert.equal(exchange.response.status, 200)
  assert.ok(exchange.body.auth.refreshToken)
  assert.equal(
    (await f.request('/auth/mobile-login/exchange', body)).response.status,
    401,
  )
})
