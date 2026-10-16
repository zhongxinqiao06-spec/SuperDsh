import { createHmac, pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto'

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export interface AuthCryptoOptions {
  secret: string | Uint8Array
  /** Unix seconds, including fractional seconds, matching Python time.time(). */
  nowSeconds: () => number
  passwordIterations?: number
}

export interface UserAccessClaims {
  sub: string
  exp: number
  sid?: string
  ver?: number
}

const passwordAlgorithm = 'pbkdf2_sha256'
const defaultExpirySeconds = 900

function equalText(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

function decodeSegment(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  const decoded = Buffer.from(value, 'base64url')
  return decoded.toString('base64url') === value ? decoded : null
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseObject(segment: string): Record<string, JsonValue> | null {
  const decoded = decodeSegment(segment)
  if (!decoded) return null
  try {
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(decoded),
    )
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

function compareUnicode(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0) ?? 0)
  const b = Array.from(right, (character) => character.codePointAt(0) ?? 0)
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference) return difference
  }
  return a.length - b.length
}

/** Python json.dumps(sort_keys=True, ensure_ascii=True, separators=(',', ':')). */
function canonicalJson(value: JsonValue): string {
  if (typeof value === 'string') {
    return JSON.stringify(value).replace(
      /[\u007f-\uffff]/g,
      (character) =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    )
  }
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    // The existing token payloads contain integer versions/expiries, not floats.
    if (!Number.isSafeInteger(value)) {
      throw new TypeError('signed token numbers must be safe integers')
    }
    return String(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value)
    .sort(compareUnicode)
    .map((key) => `${canonicalJson(key)}:${canonicalJson(value[key] ?? null)}`)
    .join(',')}}`
}

function encodeObject(value: Record<string, JsonValue>): string {
  return Buffer.from(canonicalJson(value)).toString('base64url')
}

function parsePasswordHash(
  stored: string,
): { salt: string; verifier: string } | null {
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== passwordAlgorithm || !parts[1])
    return null
  const verifier = parts[2] ?? ''
  if (decodeSegment(verifier)?.length !== 32) return null
  return { salt: parts[1], verifier }
}

/** Credential formats only. Login/session revocation and RBAC remain separate checks. */
export function createAuthCrypto(options: AuthCryptoOptions) {
  const secret = Buffer.from(options.secret)
  const iterations = options.passwordIterations ?? 120_000
  if (!secret.length) throw new TypeError('authentication secret is required')
  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new TypeError('password iterations must be a positive integer')
  }

  function now(): number {
    const seconds = options.nowSeconds()
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new TypeError('authentication clock must return Unix seconds')
    }
    return Math.trunc(seconds)
  }

  function expiry(expiresIn: number): number {
    if (!Number.isSafeInteger(expiresIn) || expiresIn < 0) {
      throw new TypeError('token lifetime must be a nonnegative integer')
    }
    const result = now() + expiresIn
    if (!Number.isSafeInteger(result))
      throw new TypeError('token expiry is invalid')
    return result
  }

  function validExpiry(value: JsonValue | undefined): value is number {
    // Existing Python tokens are valid through their exp second, inclusive.
    return (
      typeof value === 'number' && Number.isSafeInteger(value) && value >= now()
    )
  }

  function signature(value: string): string {
    return createHmac('sha256', secret)
      .update(value, 'utf8')
      .digest('base64url')
  }

  function signed(value: string, received: string): boolean {
    return (
      decodeSegment(received)?.length === 32 &&
      equalText(signature(value), received)
    )
  }

  async function hashPassword(
    password: string,
    salt = randomBytes(16).toString('base64url'),
  ) {
    if (!salt || salt.includes('$'))
      throw new TypeError('password salt is invalid')
    const derived = await new Promise<Buffer>((resolve, reject) => {
      pbkdf2(password, salt, iterations, 32, 'sha256', (error, result) => {
        if (error) reject(error)
        else resolve(result)
      })
    })
    return `${passwordAlgorithm}$${salt}$${derived.toString('base64url')}`
  }

  async function verifyPassword(
    password: string,
    stored: string,
  ): Promise<boolean> {
    const parsed = parsePasswordHash(stored)
    return (
      parsed !== null &&
      equalText(await hashPassword(password, parsed.salt), stored)
    )
  }

  function passwordSalt(stored: string): string | null {
    return parsePasswordHash(stored)?.salt ?? null
  }

  function hashPasswordVerifier(verifier: string, salt: string): string {
    const stored = `${passwordAlgorithm}$${salt}$${verifier}`
    if (!parsePasswordHash(stored))
      throw new TypeError('password verifier is invalid')
    return stored
  }

  function verifyPasswordVerifier(verifier: string, stored: string): boolean {
    const parsed = parsePasswordHash(stored)
    return parsed !== null && equalText(verifier, parsed.verifier)
  }

  function createConnectorAccessToken(
    connectorId: string,
    credentialHash: string,
    expiresIn = defaultExpirySeconds,
  ): string {
    if (!connectorId || /[.:]/.test(connectorId) || !credentialHash) {
      throw new TypeError('connector token identity is invalid')
    }
    const expiresAt = expiry(expiresIn)
    return `${connectorId}.${expiresAt}.${signature(`${connectorId}:${expiresAt}:${credentialHash}`)}`
  }

  function connectorAccessTokenId(token: string): string | null {
    const parts = token.split('.')
    return parts.length === 3 && parts[0] && !parts[0].includes(':')
      ? parts[0]
      : null
  }

  function verifyConnectorAccessToken(
    token: string,
    credentialHash: string,
  ): string | null {
    const parts = token.split('.')
    const id = connectorAccessTokenId(token)
    if (!id || !credentialHash || !/^(0|[1-9]\d*)$/.test(parts[1] ?? ''))
      return null
    const expiresAt = Number(parts[1])
    return validExpiry(expiresAt) &&
      signed(`${id}:${expiresAt}:${credentialHash}`, parts[2] ?? '')
      ? id
      : null
  }

  function createUserAccessToken(
    userId: string,
    settings: {
      expiresIn?: number
      sessionId?: string
      authVersion?: number
    } = {},
  ): string {
    if (!userId) throw new TypeError('user identity is required')
    const header = encodeObject({ alg: 'HS256', typ: 'JWT' })
    const claims: Record<string, JsonValue> = {
      sub: userId,
      exp: expiry(settings.expiresIn ?? defaultExpirySeconds),
    }
    if (settings.sessionId) {
      const version = settings.authVersion ?? 0
      if (!Number.isSafeInteger(version) || version < 0)
        throw new TypeError('authorization version is invalid')
      claims.sid = settings.sessionId
      claims.ver = version
    }
    const input = `${header}.${encodeObject(claims)}`
    return `${input}.${signature(input)}`
  }

  function userAccessClaims(token: string): UserAccessClaims | null {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [header = '', payload = '', received = ''] = parts
    if (!signed(`${header}.${payload}`, received)) return null
    const algorithm = parseObject(header)
    const claims = parseObject(payload)
    if (
      algorithm?.alg !== 'HS256' ||
      algorithm.typ !== 'JWT' ||
      algorithm.crit !== undefined ||
      !claims ||
      !validExpiry(claims.exp) ||
      typeof claims.sub !== 'string' ||
      !claims.sub
    )
      return null
    if (
      claims.sid !== undefined &&
      (typeof claims.sid !== 'string' || !claims.sid)
    )
      return null
    if (
      claims.ver !== undefined &&
      (typeof claims.ver !== 'number' ||
        !Number.isSafeInteger(claims.ver) ||
        claims.ver < 0)
    )
      return null
    return {
      sub: claims.sub,
      exp: claims.exp,
      ...(typeof claims.sid === 'string' ? { sid: claims.sid } : {}),
      ...(typeof claims.ver === 'number' ? { ver: claims.ver } : {}),
    }
  }

  function verifyUserAccessToken(token: string): string | null {
    return userAccessClaims(token)?.sub ?? null
  }

  function createSignedToken(
    kind: string,
    payload: Record<string, JsonValue>,
    expiresIn: number,
  ): string {
    if (
      !kind ||
      Object.hasOwn(payload, 'kind') ||
      Object.hasOwn(payload, 'exp')
    )
      throw new TypeError(
        'signed token payload cannot override its kind or expiry',
      )
    const body = encodeObject({ ...payload, kind, exp: expiry(expiresIn) })
    return `${body}.${signature(body)}`
  }

  function verifySignedToken(
    kind: string,
    token: string,
  ): Record<string, JsonValue> | null {
    const parts = token.split('.')
    if (parts.length !== 2) return null
    const [body = '', received = ''] = parts
    if (!signed(body, received)) return null
    const claims = parseObject(body)
    return claims?.kind === kind && validExpiry(claims.exp) ? claims : null
  }

  return {
    hashPassword,
    verifyPassword,
    passwordSalt,
    hashPasswordVerifier,
    verifyPasswordVerifier,
    createConnectorAccessToken,
    connectorAccessTokenId,
    verifyConnectorAccessToken,
    createUserAccessToken,
    userAccessClaims,
    verifyUserAccessToken,
    createSignedToken,
    verifySignedToken,
  }
}
