/** Explicit copy of local history and non-secret model settings into an empty account history. */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parse, stringify } from 'yaml'
import { assertImportSourceStopped } from '../backend/import/activity.ts'
import {
  assertRealPath,
  digestFile,
  treeFiles,
  sameFiles,
  type ImportFile,
} from '../backend/import/files.ts'
import { DEFAULT_PROFILE } from '../contracts/desktop-contract.ts'
import { NextProfiles } from './profiles.ts'
import type { DesktopImportOptions } from '../contracts/import-types.ts'
import { atomicText, readPrivateFile } from '../backend/private-files.ts'

export function publicModelConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicModelConfig)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !/(?:^|[-_])token(?:$|[-_])|(?:access|refresh|auth|bearer|id)token|secret|password|credential|api.?key|headers|environment|^env$|authorization/i.test(
              key,
            ),
        )
        .map(([key, child]) => [key, publicModelConfig(child)]),
    )
  if (typeof value === 'string' && /^https?:/.test(value)) {
    const url = new URL(value)
    if (url.username || url.password || url.search || url.hash)
      throw new Error('模型地址包含凭据或查询参数，请先清理本地配置。')
  }
  return value
}
export async function importLocalSpace(
  source: string,
  target: string,
  checks: Pick<DesktopImportOptions, 'listProcesses' | 'isProcessAlive'> = {},
): Promise<void> {
  if (source === target) throw new Error('不能导入到本地空间自身')
  await assertRealPath(source)
  await assertRealPath(target)
  await assertImportSourceStopped({
    ...checks,
    source: 'next',
    sourceHome: source,
    targetHome: target,
  })
  for (const name of ['sessions', 'attachments']) {
    if (!existsSync(join(target, name))) continue
    await assertRealPath(join(target, name))
    if ((await readdir(join(target, name))).length)
      throw new Error('目标已有历史或附件；首次导入仅接受空历史。')
  }
  if (existsSync(join(target, 'platform-import.json')))
    throw new Error('此账号空间已导入过本地历史')
  const transaction = join(dirname(target), `import-${randomUUID()}`)
  const backup = join(transaction, 'backup')
  const stage = join(transaction, 'stage')
  await mkdir(backup, { recursive: true, mode: 0o700 })
  await mkdir(stage, { mode: 0o700 })
  const paths = (await treeFiles(source)).filter(
    (path) => path.startsWith('sessions/') || path.startsWith('attachments/'),
  )
  const original: ImportFile[] = []
  for (const path of paths)
    original.push(await digestFile(source, path, backup))
  const copied: ImportFile[] = []
  for (const path of paths) copied.push(await digestFile(backup, path, stage))
  if (!sameFiles(original, copied)) throw new Error('本地历史备份校验失败')
  const sourceProfiles = new NextProfiles(source)
  const patchPath = join(
    sourceProfiles.directory(sourceProfiles.active),
    'cordis.patch.yml',
  )
  const sourcePatch = readPrivateFile(patchPath)
  const patch: unknown = sourcePatch ? parse(sourcePatch) : []
  const modelRows = Array.isArray(patch)
    ? patch
        .filter(
          (row: unknown) =>
            row &&
            typeof row === 'object' &&
            'id' in row &&
            ['llm-deepseek', 'llm-pi-ai'].includes(String(row.id)),
        )
        .map((row: { id: string; config?: unknown }) => ({
          id: row.id,
          config: publicModelConfig(row.config ?? {}),
        }))
    : []
  const targetPatch = join(
    new NextProfiles(target).directory(DEFAULT_PROFILE),
    'cordis.patch.yml',
  )
  const beforePatch = readPrivateFile(targetPatch) ?? '[]\n'
  const existing: unknown = parse(beforePatch)
  if (!Array.isArray(existing)) throw new Error('目标 Profile 配置无效')
  const merged = [
    ...existing.filter(
      (row: { id?: string }) => !modelRows.some((model) => model.id === row.id),
    ),
    ...modelRows,
  ]
  await assertImportSourceStopped({
    ...checks,
    source: 'next',
    sourceHome: source,
    targetHome: target,
  })
  const checked: ImportFile[] = []
  const finalPaths = (await treeFiles(source)).filter(
    (path) => path.startsWith('sessions/') || path.startsWith('attachments/'),
  )
  if (
    JSON.stringify(paths) !== JSON.stringify(finalPaths) ||
    readPrivateFile(patchPath) !== sourcePatch
  )
    throw new Error('导入期间源数据或配置发生变化')
  for (const path of paths) checked.push(await digestFile(source, path))
  if (!sameFiles(original, checked)) throw new Error('导入期间本地历史发生变化')
  const published: string[] = []
  const replaced: string[] = []
  try {
    for (const name of ['sessions', 'attachments']) {
      if (!existsSync(join(stage, name))) continue
      if (existsSync(join(target, name))) {
        if ((await readdir(join(target, name))).length)
          throw new Error('目标历史已变化')
        await rename(join(target, name), join(transaction, `empty-${name}`))
        replaced.push(name)
      }
      await rename(join(stage, name), join(target, name))
      published.push(name)
    }
    atomicText(targetPatch, stringify(merged))
    await writeFile(
      join(target, 'platform-import.json'),
      JSON.stringify(
        {
          version: 1,
          source,
          backup,
          files: original,
          importedAt: new Date().toISOString(),
          credentialsCopied: false,
        },
        null,
        2,
      ),
      { flag: 'wx', mode: 0o600 },
    )
  } catch (error) {
    atomicText(targetPatch, beforePatch)
    for (const name of published.reverse())
      await rename(join(target, name), join(stage, name))
    for (const name of replaced)
      await rename(join(transaction, `empty-${name}`), join(target, name))
    throw error
  }
}
