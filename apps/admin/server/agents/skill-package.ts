import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { extname, basename } from 'node:path'
import JSZip from 'jszip'
import { parseDocument } from 'yaml'
import {
  ApiError,
  object,
  requiredText,
  type Account,
} from '../http/api-router.ts'
import type { Row } from '../infrastructure/database.ts'
import { packagePath } from '../extensions/validation.ts'
import { BusinessAgentService, type AgentServiceOptions } from './service.ts'
import { AgentResourceService, resourceIds } from './resources.ts'

/** Skills are data. Executables belong to separately authorized extension packages. */
export async function readSkillPackage(bytes: Buffer, signal: AbortSignal) {
  if (!bytes.length || bytes.length > 12 * 1024 * 1024)
    throw new ApiError(413, '技能 ZIP 最多 12 MiB')
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch {
    throw new ApiError(422, '技能 ZIP 无法读取')
  }
  const entries = Object.values(zip.files)
  if (entries.length > 100) throw new ApiError(413, '技能包最多 100 个文件')
  const files = new Map<string, Buffer>()
  const names = new Set<string>()
  let total = 0
  for (const entry of entries) {
    signal.throwIfAborted()
    const path = packagePath(
      (entry.unsafeOriginalName || entry.name).replace(/\/$/u, ''),
    )
    if (names.has(path.toLowerCase())) throw new ApiError(422, '技能包路径重复')
    names.add(path.toLowerCase())
    const mode =
      typeof entry.unixPermissions === 'string'
        ? parseInt(entry.unixPermissions, 8)
        : (entry.unixPermissions ?? 0)
    if ((mode & 0o170000) === 0o120000)
      throw new ApiError(422, '技能包不能包含符号链接')
    if (entry.dir) continue
    if (
      !['.md', '.txt', '.csv', '.xlsx', '.docx', '.pptx', '.pdf'].includes(
        extname(path).toLowerCase(),
      )
    )
      throw new ApiError(
        422,
        `技能包文件 ${path} 不受支持；可执行脚本必须安装为独立授权工具，不能由技能直接执行`,
      )
    const stream = new Readable({ read() {} }).wrap(entry.nodeStream())
    const chunks: Buffer[] = []
    let size = 0
    for await (const raw of stream) {
      signal.throwIfAborted()
      const chunk = Buffer.from(raw)
      total += chunk.length
      size += chunk.length
      if (total > 24 * 1024 * 1024 || size > 4 * 1024 * 1024) {
        stream.destroy()
        throw new ApiError(413, '技能引用单文件最多 4 MiB，合计最多 24 MiB')
      }
      chunks.push(chunk)
    }
    files.set(path, Buffer.concat(chunks))
  }
  const markdown = files.get('SKILL.md')?.toString('utf8')
  if (!markdown) throw new ApiError(422, '技能包根目录需要 SKILL.md')
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(
    markdown,
  )
  if (!frontmatter)
    throw new ApiError(422, 'SKILL.md 需要 name、description YAML 元数据')
  const parsed = parseDocument(frontmatter[1]!, { uniqueKeys: true })
  if (parsed.errors.length) throw new ApiError(422, '技能 YAML 元数据无效')
  let data: Row
  try {
    data = object(parsed.toJS({ maxAliasCount: 0 }))
  } catch {
    throw new ApiError(422, '技能元数据不允许别名或无效结构')
  }
  const name = requiredText(data.name, '技能名称', 100)
  const description = requiredText(data.description, '技能说明', 1000)
  const instructions = requiredText(frontmatter[2]!.trim(), '技能指令', 12000)
  const requiredToolIds = resourceIds(
    data.requiredToolIds ?? [],
    '技能依赖工具',
  )
  const resources = [...files]
    .filter(([path]) => path !== 'SKILL.md')
    .map(([path, content]) => ({
      path,
      content,
      kind: path.startsWith('templates/')
        ? extname(path) === '.pptx'
          ? 'presentation-template'
          : extname(path) === '.docx'
            ? 'document-template'
            : extname(path) === '.xlsx'
              ? 'spreadsheet-template'
              : 'knowledge'
        : 'knowledge',
    }))
  if (
    resources.some(
      (item) => extname(item.path) === '.pptx' && item.kind === 'knowledge',
    )
  )
    throw new ApiError(422, 'PPTX 模板请放在 templates/ 目录')
  return {
    name,
    description,
    instructions,
    requiredToolIds,
    resources,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

export async function importSkillPackage(
  resources: AgentResourceService,
  account: Account,
  body: Row,
  signal: AbortSignal,
) {
  const encoded = requiredText(body.contentBase64, '技能 ZIP', 16 * 1024 * 1024)
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.toString('base64') !== encoded)
    throw new ApiError(422, '技能包编码无效')
  const parsed = await readSkillPackage(bytes, signal)
  const requiredToolIds =
    body.requiredToolIds === undefined
      ? parsed.requiredToolIds
      : resourceIds(body.requiredToolIds, '技能依赖工具')
  const catalog = await resources.catalog(account)
  if (
    requiredToolIds.some(
      (id) => !catalog.tools.some((tool) => tool.id === id && tool.enabled),
    )
  )
    throw new ApiError(422, '请先配置并启用技能依赖的工具')
  const service = new BusinessAgentService(resources.options)
  const prepared: {
    path: string
    asset: Awaited<ReturnType<BusinessAgentService['prepareUpload']>>
  }[] = []
  for (const file of parsed.resources) {
    signal.throwIfAborted()
    const asset = await service.prepareUpload(
      account,
      {
        name: basename(file.path),
        kind: file.kind,
        contentBase64: file.content.toString('base64'),
      },
      signal,
    )
    prepared.push({ path: file.path, asset })
  }
  signal.throwIfAborted()
  return resources.options.db.transaction(async (connection) => {
    const options: AgentServiceOptions = {
      ...resources.options,
      db: {
        ...resources.options.db,
        query: connection.query,
        transaction: (operation) => operation(connection),
      },
      audit: (
        actor: string,
        action: string,
        target: string,
        detail?: Record<string, unknown>,
      ) => resources.options.audit(actor, action, target, detail, connection),
    }
    const scoped = new BusinessAgentService(options)
    const references = []
    for (const file of prepared) {
      signal.throwIfAborted()
      const asset = await scoped.savePreparedUpload(account, file.asset)
      references.push({
        path: file.path,
        assetId: asset.id,
        sha256: asset.sha256,
      })
    }
    const skill = await new AgentResourceService(options).saveSkill(
      account,
      {
        name: parsed.name,
        description: parsed.description,
        instructions: parsed.instructions,
        requiredToolIds,
        enabled: true,
        references,
        packageSha256: parsed.sha256,
        version: body.version,
      },
      typeof body.id === 'string' ? body.id : undefined,
    )
    signal.throwIfAborted()
    return skill
  })
}
