import { expect, type APIRequestContext } from '@playwright/test'
import { derivePasswordVerifier } from '../../fronted/src/utils/auth/password-verifier'

/** 隔离后端验收沿用正式密码校验契约；改密后也不退回明文登录。 */
export async function loginIsolatedAccount(
  request: APIRequestContext,
  identifier: string,
  password: string,
  clientType = 'native',
) {
  if (process.env.WEB_ADMIN_E2E_LIVE !== '1')
    throw new Error('真实认证辅助方法只能用于隔离后端')
  const challenge = await request.post('/api/auth/password-salt', {
    data: { identifier },
  })
  expect(challenge.ok()).toBe(true)
  const { salt } = (await challenge.json()) as { salt: string }
  return request.post('/api/auth/login', {
    data: {
      identifier,
      passwordVerifier: await derivePasswordVerifier(password, salt),
      clientType,
    },
  })
}
