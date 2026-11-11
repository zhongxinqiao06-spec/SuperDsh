import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { appRoot } from './paths.ts'

/** 模型配置归后端 config 所有，与工作目录及数据库配置目录解耦。 */
export const defaultModelDefaultsFile = resolve(
  appRoot,
  'backend/config/model-defaults.json',
)

/** 初始化只补无凭据模板，显式路径用于独立部署及测试，绝不覆盖现有模型。 */
export async function ensureModelDefaults(
  file = defaultModelDefaultsFile,
): Promise<string> {
  const path = resolve(file)
  await mkdir(dirname(path), { recursive: true })
  if (!existsSync(path)) {
    const template = await readFile(
      resolve(appRoot, 'backend/config/model-defaults.example.json'),
    )
    try {
      await writeFile(path, template, { flag: 'wx', mode: 0o600 })
    } catch (error) {
      // 并发初始化只接纳另一个调用已创建文件，不吞权限或磁盘写入错误。
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'EEXIST'
      ))
        throw error
    }
  }
  return path
}
