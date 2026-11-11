import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { repositoryRoot, appRoot } from '../../scripts/paths.ts'
import { docker, object, validationLabel } from './deployment-docker.ts'

/** 仅挂载隔离验证目录内的输入；解析真实路径防止符号链接指向用户资料。 */
async function pairedInput(directory: string): Promise<string> {
  const root = await realpath(
    resolve(repositoryRoot, '.superdsh-work/web-admin-validation'),
  )
  const target = await realpath(resolve(directory))
  const local = relative(root, target)
  if (!local || local.startsWith('..') || isAbsolute(local))
    throw new Error('Office成对输入必须位于独立验证子目录')
  for (const kind of ['docx', 'xlsx', 'pptx']) {
    for (const version of ['old', 'new']) {
      const file = await realpath(resolve(target, `${version}.${kind}`))
      if (relative(target, file) !== `${version}.${kind}`)
        throw new Error('Office成对输入不允许外部文件链接')
      const metadata = await stat(file)
      if (!metadata.isFile() || metadata.size > 10 * 1024 * 1024)
        throw new Error('Office成对输入文件无效或过大')
    }
  }
  return target
}

/** 同一受管LibreOffice环境渲染新端案例和可选旧新成果；仅清理本轮测试资源。 */
export async function verifyOfficeRendering(
  pairDirectory = process.env.WEB_ADMIN_OFFICE_PARITY_INPUT,
): Promise<void> {
  const id = `office-${randomUUID()}`
  const image = `superdsh-web-admin-validation:${id}`
  const container = `superdsh-${id}`
  const input = pairDirectory ? await pairedInput(pairDirectory) : undefined
  const destination = resolve(
    repositoryRoot,
    '.superdsh-work/web-admin-validation',
    id,
  )
  await mkdir(destination, { recursive: true })
  console.log(`Office渲染证据：${destination}`)
  const configuration = object(
    JSON.parse(
      await readFile(resolve(appRoot, 'deployment/runtime.json'), 'utf8'),
    ),
  )
  const images = object(configuration.images)
  let built = false
  const failures: unknown[] = []
  try {
    await docker(
      [
        'build',
        '--label',
        `${validationLabel}=${id}`,
        '-f',
        resolve(appRoot, 'tests/tooling/Dockerfile.office'),
        '--build-arg',
        `PYTHON_IMAGE=${String(images.python)}`,
        '--build-arg',
        `UV_VERSION=${String(configuration.uvVersion)}`,
        '-t',
        image,
        repositoryRoot,
      ],
      '构建独立Office渲染验证镜像',
      1_800_000,
    )
    built = true
    const output = await docker(
      [
        'run',
        '--rm',
        '--name',
        container,
        '--label',
        `${validationLabel}=${id}`,
        '--network',
        'none',
        '--cpus',
        '2',
        '--memory',
        '2g',
        '--pids-limit',
        '256',
        '--mount',
        `type=bind,source=${destination},target=/evidence/.superdsh-work/web-admin-validation/${id}`,
        '-e',
        `WEB_ADMIN_VALIDATION_DIR=/evidence/.superdsh-work/web-admin-validation/${id}`,
        '-e',
        `PYTEST_ADDOPTS=--junitxml=/evidence/.superdsh-work/web-admin-validation/${id}/office-junit.xml`,
        ...(input
          ? [
              '--mount',
              `type=bind,source=${input},target=/office-pairs,readonly`,
              '-e',
              'WEB_ADMIN_OFFICE_PARITY_INPUT=/office-pairs',
            ]
          : []),
        image,
      ],
      '实际渲染DOCX/XLSX/PPTX并校验PDF和缩略图',
      input ? 900_000 : 300_000,
    )
    console.log(output)
  } catch (error) {
    failures.push(error)
  }
  // 清理失败与测试失败都保留，避免finally抛错覆盖真正的渲染故障。
  try {
    const containers = await docker(
      ['container', 'ls', '-aq', '--filter', `label=${validationLabel}=${id}`],
      '核对本轮渲染容器',
    )
    for (const identifier of containers.split(/\s+/u).filter(Boolean))
      await docker(['container', 'rm', '-f', identifier], '清理本轮渲染容器')
    if (built) {
      const labels = object(
        JSON.parse(
          await docker(
            ['image', 'inspect', '--format', '{{json .Config.Labels}}', image],
            '核对本轮测试镜像',
          ),
        ),
      )
      if (labels[validationLabel] !== id)
        throw new Error('测试镜像归属不匹配，拒绝清理')
      await docker(['image', 'rm', image], '清理本轮Office测试镜像')
    }
  } catch (error) {
    failures.push(error)
  }
  if (failures.length)
    throw new AggregateError(failures, 'Office渲染验证或资源清理失败')
}
