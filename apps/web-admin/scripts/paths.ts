import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/** 所有入口从自身位置解析仓库，避免中文路径和任意工作目录改变数据归属。 */
export const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const repositoryRoot = resolve(appRoot, '../..')
export const backendRoot = resolve(appRoot, 'backend')
export const developmentRoot = resolve(
  repositoryRoot,
  '.superdsh-work/web-admin-dev',
)
