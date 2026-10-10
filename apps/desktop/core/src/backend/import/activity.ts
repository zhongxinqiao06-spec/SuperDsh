import { execFile } from 'node:child_process'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { assertRealPath, canonicalPath, isLock } from './files.ts'
import {
  DesktopImportError,
  type DesktopImportOptions,
  type ImportProcess,
  type ImportWarning,
} from '../../contracts/import-types.ts'

const execute = promisify(execFile)
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
export async function listImportProcesses(): Promise<ImportProcess[]> {
  if (process.platform === 'win32') {
    const { stdout } = await execute(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress',
      ],
      { windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
    )
    const value: unknown = JSON.parse(stdout.replace(/^\uFEFF/u, ''))
    const rows = Array.isArray(value) ? value : [value]
    return rows
      .filter((row) => typeof row?.ProcessId === 'number')
      .map((row) => ({
        pid: row.ProcessId,
        name: String(row.Name ?? ''),
        commandLine: String(row.CommandLine ?? ''),
      }))
  }
  const { stdout } = await execute('ps', ['-axo', 'pid=,args='], {
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
  })
  return stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line)
    return match
      ? [{ pid: Number(match[1]), name: '', commandLine: match[2]! }]
      : []
  })
}
export async function assertImportSourceStopped(
  options: DesktopImportOptions,
): Promise<ImportWarning[]> {
  const warnings: ImportWarning[] = []
  const alive = options.isProcessAlive ?? isProcessAlive
  let processes: readonly ImportProcess[]
  try {
    processes = await (options.listProcesses ?? listImportProcesses)()
  } catch {
    throw new DesktopImportError(
      'process-check-failed',
      '无法核对旧应用进程。请关闭旧桌面与后台服务后重试。',
    )
  }
  const source = options.sourceHome.replaceAll('\\', '/').toLowerCase()
  for (const item of processes) {
    if (item.pid === process.pid) continue
    const command = item.commandLine?.replaceAll('\\', '/').toLowerCase() ?? ''
    if (
      /^(?:DSH Desktop(?: Beta)?|DSH NEXT)(?:\.exe)?$/iu.test(item.name) ||
      /(?:^|\/)(?:dsh desktop(?: beta)?|dsh next)(?:\.app\/|\s|$)/iu.test(
        command,
      ) ||
      /(?:^|\/)(?:dsh-desktop|dsh-next|dsh-plugin-desktop|dsh-desktop-next)(?:\s|$)/iu.test(
        command,
      ) ||
      /(?:dsh-plugin-desktop(?:-beta)?|dsh-desktop-next)\/(?:lib\/)?(?:main|host|bin)\.[cm]?[jt]s/iu.test(
        command,
      ) ||
      command.includes(source)
    ) {
      throw new DesktopImportError(
        'source-running',
        `请先退出旧桌面及其后台进程（PID ${item.pid}），然后重试。`,
      )
    }
  }
  const ignored = new Set([
    'node_modules',
    '.git',
    'logs',
    'cache',
    'caches',
    '.cache',
    'recovery',
  ])
  async function locks(directory: string): Promise<void> {
    await assertRealPath(directory)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (
        ignored.has(entry.name) ||
        ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'].includes(
          entry.name,
        )
      )
        continue
      const path = join(directory, entry.name)
      if (isLock(entry.name)) {
        const info = await lstat(path)
        if (!info.isFile() || info.isSymbolicLink() || info.size > 128)
          throw new DesktopImportError(
            'source-locked',
            `无法确认数据锁已释放：${path}`,
          )
        const text = (await readFile(path, 'utf8')).trim()
        const pid = /^\d+$/u.test(text) ? Number(text) : 0
        if (!Number.isSafeInteger(pid) || pid < 1 || alive(pid))
          throw new DesktopImportError(
            'source-locked',
            `数据目录仍被占用或锁状态不明：${path}`,
          )
        warnings.push({
          code: 'stale-lock',
          message: '已跳过确认进程不存在的旧锁；源锁文件保留不变。',
          path,
        })
      } else if (entry.isDirectory() && !entry.isSymbolicLink())
        await locks(path)
    }
  }
  await locks(options.sourceHome)
  if (options.sourceUserData) {
    const userData = canonicalPath(options.sourceUserData)
    await assertRealPath(userData)
    const marker = join(userData, 'crash-evidence', 'active-run.json')
    try {
      await assertRealPath(join(userData, 'crash-evidence'))
      const info = await lstat(marker)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024)
        throw new DesktopImportError('source-locked', '旧应用运行标记不安全。')
      const value = JSON.parse(await readFile(marker, 'utf8')) as {
        pid?: unknown
      }
      if (
        !Number.isSafeInteger(value.pid) ||
        Number(value.pid) < 1 ||
        alive(Number(value.pid))
      )
        throw new DesktopImportError(
          'source-running',
          '旧应用运行标记仍指向活动进程或无法确认。',
        )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return warnings
}
