import { execFileSync } from 'node:child_process'
import { relative } from 'node:path'
import { repositoryRoot } from '../../scripts/paths.ts'

/** 格式检查只覆盖 Git 已跟踪及未忽略的源码，避免读写用户私有运行配置。 */
export function repositoryFormatFiles(
  candidates: string[],
  directory = repositoryRoot,
): string[] {
  const visible = new Set(
    execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: directory, encoding: 'utf8', windowsHide: true },
    )
      .split('\0')
      .filter(Boolean),
  )
  return candidates.filter((file) =>
    visible.has(relative(directory, file).replaceAll('\\', '/')),
  )
}
