const iterations = 120_000

/** 与既有客户端密码挑战保持一致；密码不写日志或持久化。 */
export async function derivePasswordVerifier(
  password: string,
  salt: string,
): Promise<string> {
  const passwordBytes = new TextEncoder().encode(password)
  const saltBytes = new TextEncoder().encode(salt)
  try {
    if (globalThis.crypto?.subtle) {
      const key = await crypto.subtle.importKey(
        'raw',
        passwordBytes,
        'PBKDF2',
        false,
        ['deriveBits'],
      )
      const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations },
        key,
        256,
      )
      return base64Url(new Uint8Array(bits))
    }
    const [{ pbkdf2Async }, { sha256 }] = await Promise.all([
      import('@noble/hashes/pbkdf2.js'),
      import('@noble/hashes/sha2.js'),
    ])
    return base64Url(
      await pbkdf2Async(sha256, passwordBytes, saltBytes, {
        c: iterations,
        dkLen: 32,
        asyncTick: 10,
      }),
    )
  } finally {
    passwordBytes.fill(0)
  }
}

/** 创建新账号密码挑战；盐为随机字节的base64url表示。 */
export async function createPasswordVerifier(
  password: string,
): Promise<{ passwordSalt: string; passwordVerifier: string }> {
  const passwordSalt = base64Url(crypto.getRandomValues(new Uint8Array(16)))
  return {
    passwordSalt,
    passwordVerifier: await derivePasswordVerifier(password, passwordSalt),
  }
}

function base64Url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}
