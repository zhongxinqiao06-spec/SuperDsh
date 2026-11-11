import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { appRoot } from './paths.ts'

/** 只用于空库的首个管理员；后端不会据此重置已有账号。 */
export interface InitialAdminConfiguration {
  username: string
  password: string
  displayName: string
}

/** 缺失时读取集中默认配置；显式配置无效时拒绝启动，避免静默换回默认凭据。 */
export async function initialAdminConfiguration(
  value?: unknown,
): Promise<InitialAdminConfiguration> {
  const candidate: unknown =
    value === undefined
      ? JSON.parse(
          await readFile(
            resolve(appRoot, 'deployment/initial-admin.json'),
            'utf8',
          ),
        )
      : value
  if (!candidate || typeof candidate !== 'object')
    throw new Error('initialAdmin 配置必须为对象')
  const { username, password, displayName } = candidate as Record<
    string,
    unknown
  >
  if (
    typeof username !== 'string' ||
    typeof password !== 'string' ||
    typeof displayName !== 'string' ||
    displayName.length > 100 ||
    !(
      (username === '' && password === '') ||
      (/^[a-z0-9_-]{3,32}$/u.test(username) &&
        password.length >= 8 &&
        password.length <= 1024)
    )
  )
    throw new Error('initialAdmin 配置无效，请检查用户名、密码及显示名称')
  return { username, password, displayName }
}
