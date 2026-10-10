import { constants } from 'node:fs'
import { lstat, open, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseDocument, visit } from 'yaml'
import { assertRealPath } from './files.ts'
import {
  DesktopImportError,
  type ImportProfile,
  type ImportWarning,
} from '../../contracts/import-types.ts'

export const IMPORT_APPLICATION_BUNDLES = [
  '@superdsh/harness',
  '@superdsh/desktop',
] as const
const oldDesktop = new Set([
  'dsh-plugin-desktop',
  'dsh-plugin-desktop-beta',
  'dsh-desktop-next',
])
const aa = '@agents-anywhere/dsh-bridge-next'
export function validProfileName(name: string): boolean {
  return (
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(name) &&
    !/^(?:node_modules|con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(name)
  )
}
export async function readImportJson(
  path: string,
): Promise<Record<string, unknown>> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024)
    throw new DesktopImportError(
      'invalid-profile',
      `配置必须是大小受限的普通文件：${path}`,
    )
  const handle = await open(
    path,
    constants.O_RDONLY |
      (process.platform === 'win32'
        ? 0
        : constants.O_NOFOLLOW | constants.O_NONBLOCK),
  )
  let value: unknown
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.ino !== info.ino ||
      opened.dev !== info.dev ||
      opened.size > 2 * 1024 * 1024
    )
      throw new DesktopImportError(
        'source-changed',
        `配置在读取前发生变化：${path}`,
      )
    value = JSON.parse(await handle.readFile('utf8'))
    const after = await handle.stat()
    if (
      opened.size !== after.size ||
      opened.mtimeMs !== after.mtimeMs ||
      opened.ctimeMs !== after.ctimeMs
    )
      throw new DesktopImportError('source-changed', `配置正在写入：${path}`)
  } finally {
    await handle.close()
  }
  if (!record(value))
    throw new DesktopImportError(
      'invalid-profile',
      `配置不是 JSON 对象：${path}`,
    )
  return value
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function profile(manifest: Record<string, unknown>): {
  dsh: Record<string, unknown>
  profile: Record<string, unknown>
  bundles: string[]
} {
  const dsh = manifest.dsh
  const data = record(dsh) ? dsh.profile : undefined
  const bundles = record(data) ? data.bundles : undefined
  if (
    !record(dsh) ||
    !record(data) ||
    !Array.isArray(bundles) ||
    bundles.some((name) => typeof name !== 'string')
  )
    throw new DesktopImportError(
      'invalid-profile',
      'Profile 缺少有效的 dsh.profile.bundles。',
    )
  return { dsh, profile: data, bundles: bundles as string[] }
}
function checkDependencies(manifest: Record<string, unknown>): void {
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    const deps = manifest[field]
    if (deps === undefined) continue
    if (!record(deps))
      throw new DesktopImportError(
        'invalid-profile',
        `Profile ${field} 必须是对象。`,
      )
    for (const [name, range] of Object.entries(deps)) {
      if (
        oldDesktop.has(name) ||
        IMPORT_APPLICATION_BUNDLES.includes(
          name as (typeof IMPORT_APPLICATION_BUNDLES)[number],
        ) ||
        name === aa
      )
        continue
      if (
        typeof range !== 'string' ||
        /^(?:file:|link:|portal:|workspace:|\.\.?[/\\]|[/\\]|[a-z]:[/\\])/iu.test(
          range,
        )
      ) {
        throw new DesktopImportError(
          'local-dependency',
          `插件 ${name} 使用本地路径依赖，请先改为可重新安装的发布版本。`,
        )
      }
    }
  }
}
export async function inspectProfiles(home: string): Promise<ImportProfile[]> {
  const root = join(home, 'profiles')
  await assertRealPath(root)
  const result: ImportProfile[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !validProfileName(entry.name)
    )
      throw new DesktopImportError(
        'invalid-profile',
        `Profile 目录不安全或名称不受支持：${entry.name}`,
      )
    const manifest = await readImportJson(
      join(root, entry.name, 'package.json'),
    )
    checkDependencies(manifest)
    result.push({ name: entry.name, bundles: profile(manifest).bundles })
  }
  if (!result.length)
    throw new DesktopImportError(
      'no-profiles',
      '源目录没有可导入的 Profile，请选择实际的 Harness Home。',
    )
  return result.sort((left, right) => left.name.localeCompare(right.name, 'en'))
}
async function convertPatch(
  path: string,
  warnings: ImportWarning[],
): Promise<void> {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024)
    throw new DesktopImportError(
      'invalid-patch',
      `补丁文件不安全或过大：${path}`,
    )
  const doc = parseDocument(await readFile(path, 'utf8'))
  if (doc.errors.length)
    throw new DesktopImportError('invalid-patch', `无法解析补丁：${path}`)
  let changed = false
  visit(doc, {
    Map(_key, node) {
      const name = node.get('name')
      if (
        name === 'dsh-desktop-next' ||
        name === 'dsh-desktop-next/webserver'
      ) {
        node.set('name', name.replace('dsh-desktop-next', '@superdsh/harness'))
        changed = true
      } else if (
        typeof name === 'string' &&
        /^(?:dsh-plugin-desktop(?:-beta)?|dsh-desktop-next)(?:\/|$)/u.test(name)
      ) {
        node.set('disabled', true)
        warnings.push({
          code: 'legacy-patch-disabled',
          message: `旧桌面插件 ${name} 已停用，请在新应用中复核配置。`,
          path,
        })
        changed = true
      }
    },
  })
  if (changed) await writeFile(path, String(doc), { mode: 0o600 })
}
export async function convertImportedProfiles(
  home: string,
  profiles: readonly ImportProfile[],
  active: string,
): Promise<ImportWarning[]> {
  const warnings: ImportWarning[] = []
  await convertPatch(join(home, 'cordis.patch.yml'), warnings)
  for (const entry of profiles) {
    const directory = join(home, 'profiles', entry.name)
    const path = join(directory, 'package.json')
    const manifest = await readImportJson(path)
    const data = profile(manifest)
    // Imported profiles declare plugins; application-owned installation policy
    // must not inherit hooks, workspaces, stores or dependency redirects.
    const installationFields = [
      'scripts',
      'pnpm',
      'workspaces',
      'resolutions',
      'overrides',
      'packageManager',
      'devEngines',
    ]
    const removedFields = installationFields.filter((field) =>
      Object.hasOwn(manifest, field),
    )
    for (const field of removedFields) delete manifest[field]
    if (removedFields.length)
      warnings.push({
        code: 'install-policy-reset',
        message: `Profile ${entry.name} 的旧安装配置已移除，原始配置保留在备份中。`,
      })
    data.profile.bundles = [
      ...new Set([
        ...data.bundles.filter((name) => !oldDesktop.has(name) && name !== aa),
        ...IMPORT_APPLICATION_BUNDLES,
      ]),
    ]
    if (data.bundles.includes(aa))
      warnings.push({
        code: 'remote-disabled',
        message: `Profile ${entry.name} 的远控已暂时关闭，重新登录并绑定设备后再开启。`,
      })
    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      const dependencies = manifest[field]
      if (record(dependencies))
        for (const name of [...oldDesktop, ...IMPORT_APPLICATION_BUNDLES, aa])
          delete dependencies[name]
    }
    data.dsh.desktopNextPlugins = 1
    // Keep the existing onboarding record; import review carries reauthorization separately.
    if (Array.isArray(data.dsh.desktopNextDeselectedBundles))
      data.dsh.desktopNextDeselectedBundles =
        data.dsh.desktopNextDeselectedBundles.filter(
          (name) =>
            typeof name === 'string' &&
            !oldDesktop.has(name) &&
            !IMPORT_APPLICATION_BUNDLES.includes(
              name as (typeof IMPORT_APPLICATION_BUNDLES)[number],
            ),
        )
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    })
    await convertPatch(join(directory, 'cordis.patch.yml'), warnings)
    await convertPatch(join(directory, 'cordis.patch.yaml'), warnings)
  }
  await writeFile(
    join(home, 'desktop-next.json'),
    `${JSON.stringify({ version: 1, active }, null, 2)}\n`,
    { mode: 0o600 },
  )
  return warnings
}
