import { lstat, readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import JSZip from 'jszip'
import { ApiError } from '../http/api-router.ts'
import { installedEntrypoint } from './process.ts'
import { packagePath } from './validation.ts'

/** Export data only from one installed skill, never dependencies or executable code. */
export async function installedSkillArchive(
  root: string,
  entrypoint: string,
  signal: AbortSignal,
) {
  const entry = await installedEntrypoint(root, entrypoint)
  const directory = dirname(entry)
  const zip = new JSZip()
  let count = 0,
    size = 0
  const add = async (path: string, name: string) => {
    signal.throwIfAborted()
    const stat = await lstat(path)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 4 * 1024 * 1024 ||
      ++count > 100 ||
      (size += stat.size) > 24 * 1024 * 1024
    )
      throw new ApiError(422, '技能引用包含链接、特殊文件或超过大小限制')
    zip.file(name, await readFile(path))
  }
  const walk = async (relative: string, depth = 0) => {
    signal.throwIfAborted()
    if (depth > 8) throw new ApiError(422, '技能目录过深')
    const path = join(directory, packagePath(relative))
    const stat = await lstat(path).catch((error) => {
      if (error.code === 'ENOENT' && depth === 0) return null
      throw error
    })
    if (!stat) return
    if (stat.isSymbolicLink()) throw new ApiError(422, '技能引用不能包含链接')
    if (stat.isDirectory()) {
      const entries = await readdir(path)
      if (entries.length > 100) throw new ApiError(422, '技能引用过多')
      for (const name of entries) await walk(`${relative}/${name}`, depth + 1)
    } else await add(path, relative)
  }
  await add(entry, 'SKILL.md')
  await walk('references')
  await walk('templates')
  signal.throwIfAborted()
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
