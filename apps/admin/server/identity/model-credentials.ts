import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) {
    throw new TypeError('invalid credential encoding')
  }
  const decoded = Buffer.from(value, 'base64url')
  if (
    decoded.toString('base64url') !== value.replace(/=+$/, '') ||
    (value.includes('=') && paddedBase64Url(decoded) !== value)
  ) {
    throw new TypeError('invalid credential encoding')
  }
  return decoded
}

function paddedBase64Url(value: Buffer): string {
  return value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_')
}

export function modelCredentialIdentity(
  providerId: string,
  ownerId?: string,
): string {
  if (!providerId) throw new TypeError('provider identity is required')
  return ownerId ? `personal:${ownerId}:${providerId}` : providerId
}

/** Existing Python AESGCM layout: nonce(12) + ciphertext + authentication tag(16). */
export function createModelCredentialCipher(encodedKey: string) {
  const key = decodeBase64Url(encodedKey)
  if (key.length !== 32)
    throw new TypeError('model encryption key must encode 32 bytes')

  function seal(value: string, credentialIdentity: string): string {
    if (!credentialIdentity)
      throw new TypeError('credential identity is required')
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, nonce, {
      authTagLength: 16,
    })
    cipher.setAAD(Buffer.from(credentialIdentity, 'utf8'))
    const ciphertext = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ])
    return paddedBase64Url(
      Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]),
    )
  }

  function open(value: string, credentialIdentity: string): string {
    try {
      if (!credentialIdentity) throw new Error('missing credential identity')
      const data = decodeBase64Url(value)
      if (data.length < 28) throw new Error('incomplete credential')
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        data.subarray(0, 12),
        { authTagLength: 16 },
      )
      decipher.setAAD(Buffer.from(credentialIdentity, 'utf8'))
      decipher.setAuthTag(data.subarray(-16))
      const plaintext = Buffer.concat([
        decipher.update(data.subarray(12, -16)),
        decipher.final(),
      ])
      return new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
    } catch {
      // Operational errors must not expose keys, values or other accounts' IDs.
      throw new Error('platform provider credential cannot be decrypted')
    }
  }

  return { seal, open }
}
