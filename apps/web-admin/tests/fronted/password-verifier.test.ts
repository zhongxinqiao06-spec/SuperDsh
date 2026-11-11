import { pbkdf2Sync, webcrypto } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import {
  createPasswordVerifier,
  derivePasswordVerifier,
} from '@/utils/auth/password-verifier'

it('密码挑战与既有PBKDF2参数一致，随机盐不重复', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const salt = 'known-test-salt'
  const expected = pbkdf2Sync(
    'sample-password',
    salt,
    120_000,
    32,
    'sha256',
  ).toString('base64url')
  expect(await derivePasswordVerifier('sample-password', salt)).toBe(expected)
  const first = await createPasswordVerifier('sample-password')
  const second = await createPasswordVerifier('sample-password')
  expect(first.passwordSalt).not.toBe(second.passwordSalt)
  expect(first.passwordVerifier).toBe(
    await derivePasswordVerifier('sample-password', first.passwordSalt),
  )
})
