import assert from 'node:assert/strict'
import { createHmac, webcrypto } from 'node:crypto'
import test from 'node:test'

import { createAuthCrypto } from '../identity/auth-crypto.ts'
import {
  createModelCredentialCipher,
  modelCredentialIdentity,
} from '../identity/model-credentials.ts'

// Synthetic vectors generated with the existing Python core/auth.py and
// PlatformModels._seal, at time.time()=1700000000.9, never from a user database.
// These committed expectations keep the regression suite independent of Python.
const secret = 'fixture-only-签名-secret'
const password = '密码🔑 café'
const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index))
const vectors = {
  passwordHash:
    'pbkdf2_sha256$fixture-salt_ZA$1xMJz5zvJumqn6W_eHaO6bwIJsggvvEyCW45FpwL1Lo',
  userToken:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE3MDAwMDA5MDAsInNpZCI6InNlc19maXh0dXJlIiwic3ViIjoidXNlcl9cdTc1MjhcdTYyMzciLCJ2ZXIiOjd9._Jcpc8i-JAd_Ec14OP7EKmVxJAEcHKOopJxH-awcNc8',
  legacyUserToken:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE3MDAwMDA5MDAsInN1YiI6InVzZXJfZml4dHVyZSJ9.6xFIab_VcYfngo3NKvc1wedmh6Sh56gZKXcCa55b-es',
  connectorToken:
    'con_fixture.1700000900.nlj5G9UMNcJlKqMipF5oPaG63yPfahAdW3iW3Lswf-Q',
  signedToken:
    'eyJleHAiOjE3MDAwMDAzMDAsImtpbmQiOiJmc19wcmV2aWV3X2FjY2VzcyIsIm1ldGEiOnsiYSI6WzEsbnVsbCwiXHVkODNkXHVkZDExIl0sInoiOnRydWV9LCJwYXRoIjoiRDpcXFx1OTg3OVx1NzZlZVxcXHU2NTg3XHU0ZWY2LnR4dCIsInVzZXJfaWQiOiJ1c2VyX1x1NzUyOFx1NjIzNyJ9.WCTJBt79eQC-UanxNTZazMATGTlWNJt_kiBZthVQLks',
  encryptedKey:
    'AAECAwQFBgcICQoLIWuub7CXpzbsMf6m2owBQGZ5Ad1i3hCodGXB0SpOiAxZ-F8sbbc=',
}
const signedPayload = {
  user_id: 'user_用户',
  path: 'D:\\项目\\文件.txt',
  meta: { z: true, a: [1, null, '🔑'] },
}
const clock = (seconds = 1700000000.9) =>
  createAuthCrypto({ secret, nowSeconds: () => seconds })

function customJwt(header, payload) {
  const body = [header, payload]
    .map((value) => Buffer.from(JSON.stringify(value)).toString('base64url'))
    .join('.')
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}

test('async PBKDF2 reproduces the legacy Unicode password and verifier formats', async () => {
  const auth = clock()
  const pending = auth.hashPassword(password, 'fixture-salt_ZA')
  assert.ok(pending instanceof Promise)
  assert.equal(await pending, vectors.passwordHash)
  assert.equal(await auth.verifyPassword(password, vectors.passwordHash), true)
  assert.equal(
    await auth.verifyPassword(password + 'x', vectors.passwordHash),
    false,
  )
  assert.equal(auth.passwordSalt(vectors.passwordHash), 'fixture-salt_ZA')
  const verifier = vectors.passwordHash.split('$')[2]
  assert.equal(
    auth.hashPasswordVerifier(verifier, 'fixture-salt_ZA'),
    vectors.passwordHash,
  )
  assert.equal(
    auth.verifyPasswordVerifier(verifier, vectors.passwordHash),
    true,
  )
  assert.equal(
    auth.verifyPasswordVerifier(verifier + 'x', vectors.passwordHash),
    false,
  )
})

test('password salts are random and malformed stored hashes fail closed', async () => {
  const auth = createAuthCrypto({
    secret,
    nowSeconds: () => 1700000000,
    passwordIterations: 10,
  })
  const first = await auth.hashPassword('local-test-only')
  const second = await auth.hashPassword('local-test-only')
  assert.notEqual(first, second)
  assert.equal(await auth.verifyPassword('local-test-only', first), true)
  for (const malformed of [
    '',
    'bcrypt$abc$def',
    'pbkdf2_sha256$$abc',
    vectors.passwordHash + '$x',
    vectors.passwordHash + '=',
  ]) {
    assert.equal(await auth.verifyPassword(password, malformed), false)
    assert.equal(auth.passwordSalt(malformed), null)
  }
  assert.throws(() => auth.hashPasswordVerifier('', 'salt'), /invalid/)
  await assert.rejects(auth.hashPassword(password, 'invalid$salt'), /invalid/)
})

test('HS256 JWT creation is byte-identical to Python including sorted escaped Unicode', () => {
  const auth = clock()
  assert.equal(
    auth.createUserAccessToken('user_用户', {
      sessionId: 'ses_fixture',
      authVersion: 7,
    }),
    vectors.userToken,
  )
  assert.deepEqual(auth.userAccessClaims(vectors.userToken), {
    sub: 'user_用户',
    exp: 1700000900,
    sid: 'ses_fixture',
    ver: 7,
  })
  assert.equal(
    auth.createUserAccessToken('user_fixture'),
    vectors.legacyUserToken,
  )
  assert.equal(
    auth.verifyUserAccessToken(vectors.legacyUserToken),
    'user_fixture',
  )
})

test('token verification retains Python inclusive second-boundary expiry', () => {
  assert.equal(
    clock(1700000900.999).verifyUserAccessToken(vectors.userToken),
    'user_用户',
  )
  assert.equal(clock(1700000901).verifyUserAccessToken(vectors.userToken), null)
  assert.equal(
    clock(1700000900.999).verifyConnectorAccessToken(
      vectors.connectorToken,
      'fixture-hash-abc123',
    ),
    'con_fixture',
  )
  assert.equal(
    clock(1700000901).verifyConnectorAccessToken(
      vectors.connectorToken,
      'fixture-hash-abc123',
    ),
    null,
  )
  assert.ok(
    clock(1700000300.999).verifySignedToken(
      'fs_preview_access',
      vectors.signedToken,
    ),
  )
  assert.equal(
    clock(1700000301).verifySignedToken(
      'fs_preview_access',
      vectors.signedToken,
    ),
    null,
  )
})

test('JWT rejects invalid signatures, malformed encodings and unexpected algorithms or claim types', () => {
  const auth = clock()
  const header = { alg: 'HS256', typ: 'JWT' }
  for (const malformed of [
    '',
    vectors.userToken + '.x',
    vectors.userToken + '=',
    vectors.userToken.slice(0, -1),
    vectors.userToken.replace('eyJleHA', 'eyJneHA'),
  ]) {
    assert.equal(auth.userAccessClaims(malformed), null)
  }
  assert.equal(
    createAuthCrypto({
      secret: 'wrong-fixture-secret',
      nowSeconds: () => 1700000000,
    }).userAccessClaims(vectors.userToken),
    null,
  )
  for (const invalidHeader of [
    { alg: 'none', typ: 'JWT' },
    { alg: 'HS512', typ: 'JWT' },
    { alg: 'HS256', typ: 'OTHER' },
    { ...header, crit: ['custom'] },
  ]) {
    assert.equal(
      auth.userAccessClaims(
        customJwt(invalidHeader, { sub: 'u', exp: 1700000900 }),
      ),
      null,
    )
  }
  for (const invalidClaims of [
    [],
    null,
    { sub: '', exp: 1700000900 },
    { sub: 'u', exp: '1700000900' },
    { sub: 'u', exp: 1700000900.5 },
    { sub: 'u', exp: 1700000900, sid: [] },
    { sub: 'u', exp: 1700000900, ver: -1 },
  ]) {
    assert.equal(auth.userAccessClaims(customJwt(header, invalidClaims)), null)
  }
})

test('Connector HMAC is legacy-compatible and tied to current credential hash', () => {
  const auth = clock()
  assert.equal(
    auth.createConnectorAccessToken('con_fixture', 'fixture-hash-abc123'),
    vectors.connectorToken,
  )
  assert.equal(
    auth.connectorAccessTokenId(vectors.connectorToken),
    'con_fixture',
  )
  assert.equal(
    auth.verifyConnectorAccessToken(
      vectors.connectorToken,
      'fixture-hash-abc123',
    ),
    'con_fixture',
  )
  assert.equal(
    auth.verifyConnectorAccessToken(
      vectors.connectorToken,
      'rotated-credential',
    ),
    null,
  )
  assert.equal(
    auth.verifyConnectorAccessToken(
      vectors.connectorToken.replace('con_fixture', 'con_other'),
      'fixture-hash-abc123',
    ),
    null,
  )
  for (const malformed of [
    'con_fixture',
    vectors.connectorToken + '.x',
    vectors.connectorToken.replace('1700000900', '+1700000900'),
    vectors.connectorToken + '=',
  ]) {
    assert.equal(
      auth.verifyConnectorAccessToken(malformed, 'fixture-hash-abc123'),
      null,
    )
  }
  assert.throws(
    () => auth.createConnectorAccessToken('con.invalid', 'hash'),
    /invalid/,
  )
})

test('signed grants reproduce Python canonical nested payloads and reject wrong purposes', () => {
  const auth = clock()
  assert.equal(
    auth.createSignedToken('fs_preview_access', signedPayload, 300),
    vectors.signedToken,
  )
  assert.deepEqual(
    auth.verifySignedToken('fs_preview_access', vectors.signedToken),
    { ...signedPayload, kind: 'fs_preview_access', exp: 1700000300 },
  )
  assert.equal(auth.verifySignedToken('oauth_grant', vectors.signedToken), null)
  assert.equal(
    auth.verifySignedToken('fs_preview_access', vectors.signedToken + '='),
    null,
  )
  assert.equal(
    auth.verifySignedToken(
      'fs_preview_access',
      vectors.signedToken.slice(0, -1),
    ),
    null,
  )
  assert.throws(
    () => auth.createSignedToken('grant', { kind: 'override' }, 1),
    /override/,
  )
  assert.throws(
    () => auth.createSignedToken('grant', { exp: 9999999999 }, 1),
    /override/,
  )
  assert.throws(
    () => auth.createSignedToken('grant', { version: 1.5 }, 1),
    /safe integers/,
  )
})

test('invalid signing configuration fails before use', () => {
  assert.throws(
    () => createAuthCrypto({ secret: '', nowSeconds: () => 0 }),
    /required/,
  )
  assert.throws(
    () =>
      createAuthCrypto({ secret, nowSeconds: () => 0, passwordIterations: 0 }),
    /positive integer/,
  )
  assert.throws(() => clock(NaN).createUserAccessToken('user'), /clock/)
  assert.throws(
    () => clock().createUserAccessToken('user', { expiresIn: -1 }),
    /lifetime/,
  )
})

test('existing AES-GCM provider key decrypts using its exact personal scope', () => {
  const cipher = createModelCredentialCipher(key.toString('base64url'))
  assert.equal(
    modelCredentialIdentity('provider_1', 'user_用户'),
    'personal:user_用户:provider_1',
  )
  assert.equal(modelCredentialIdentity('provider_1'), 'provider_1')
  assert.equal(
    cipher.open(vectors.encryptedKey, 'personal:user_用户:provider_1'),
    'fixture-api-key-密钥',
  )
  assert.throws(
    () => cipher.open(vectors.encryptedKey, 'personal:user_other:provider_1'),
    /cannot be decrypted/,
  )
  assert.throws(
    () => cipher.open(vectors.encryptedKey, 'provider_1'),
    /cannot be decrypted/,
  )
})

test('new encrypted keys use random 12-byte nonces, padded base64url and Python-compatible AES-GCM layout', async () => {
  const cipher = createModelCredentialCipher(key.toString('base64url'))
  const value = 'fixture-only-新密钥'
  const identity = modelCredentialIdentity('provider_local')
  const first = cipher.seal(value, identity)
  const second = cipher.seal(value, identity)
  assert.notEqual(first, second)
  assert.equal(first.length % 4, 0)
  assert.equal(cipher.open(first, identity), value)
  const data = Buffer.from(first, 'base64url')
  assert.equal(data.length, Buffer.byteLength(value) + 12 + 16)
  const imported = await webcrypto.subtle.importKey(
    'raw',
    key,
    'AES-GCM',
    false,
    ['decrypt'],
  )
  const decrypted = await webcrypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: data.subarray(0, 12),
      additionalData: Buffer.from(identity),
      tagLength: 128,
    },
    imported,
    data.subarray(12),
  )
  assert.equal(new TextDecoder().decode(decrypted), value)
})

test('wrong key, corrupt nonce/ciphertext/tag and truncated credentials never expose secrets', () => {
  const cipher = createModelCredentialCipher(key.toString('base64url'))
  const identity = 'personal:user_用户:provider_1'
  for (const position of [0, 12, 28, -1]) {
    const bytes = Buffer.from(vectors.encryptedKey, 'base64url')
    const offset = position < 0 ? bytes.length - 1 : position
    bytes[offset] ^= 1
    assert.throws(() => cipher.open(bytes.toString('base64url'), identity), {
      message: 'platform provider credential cannot be decrypted',
    })
  }
  const wrongKey = createModelCredentialCipher(
    Buffer.alloc(32, 5).toString('base64url'),
  )
  assert.throws(
    () => wrongKey.open(vectors.encryptedKey, identity),
    /cannot be decrypted/,
  )
  for (const invalid of [
    '',
    'invalid!!',
    'aGVsbG8=',
    vectors.encryptedKey + '=',
  ]) {
    assert.throws(() => cipher.open(invalid, identity), /cannot be decrypted/)
  }
  assert.throws(() => createModelCredentialCipher('bad'), /32 bytes|encoding/)
})
