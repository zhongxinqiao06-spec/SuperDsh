import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { backendRoot, repositoryRoot } from './paths.ts'

/** 构建信息只派生自产品发布清单和已固定引擎来源，不提供过期版本兜底。 */
export async function generateBuildInfo() {
  const readJson = async (path: string) =>
    JSON.parse(await readFile(resolve(repositoryRoot, path), 'utf8'))
  const product = await readJson('apps/desktop/package.json')
  const upstream = await readJson('upstream.json')
  const channel = upstream.channels[upstream.activeChannel]
  const engine = await readJson(channel.runtimeSource)
  if (!product.version || engine.version !== channel.runtimePackageVersion) {
    throw new Error('发布元数据缺失或固定引擎来源不一致')
  }
  let commit = process.env.WEB_ADMIN_SOURCE_COMMIT
  if (!commit) {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }).trim()
  }
  const info = {
    version: product.version,
    commit,
    builtAt: new Date().toISOString(),
    engine: {
      version: engine.version,
      source: channel.runtimeSource,
      commit: engine.commit,
    },
  }
  const output = resolve(backendRoot, 'resources/build-info.json')
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(info, null, 2)}\n`)
  return info
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const info = await generateBuildInfo()
  console.log(`Web Admin ${info.version}; DSH ${info.engine.version}`)
}
