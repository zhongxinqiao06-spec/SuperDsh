import type { Page } from '@playwright/test'
import type {
  AgentAsset,
  AgentDefinition,
} from '../../fronted/src/types/agents/agents.ts'
import type { KnowledgeBase } from '../../fronted/src/types/knowledge/knowledge.ts'
import type { FileEntry } from '../../fronted/src/types/files/files.ts'
import { installParityFixture } from './ui-fixture.ts'

/** 填充场景使用精确资源路由与有状态写入；不会把 GET 读模型作为任意写成功响应。 */
export async function installResourceFixture(
  page: Page,
  options: { permissions?: string[] } = {},
) {
  await installParityFixture(page, options)
  const time = '2026-11-01T00:00:00.000Z'
  const assets: AgentAsset[] = [
    {
      id: 'filled-asset',
      name: '合成资料.txt',
      kind: 'knowledge',
      size: 9,
      mediaType: 'text/plain',
      sha256: 'synthetic-sha',
      preview: '合成资料内容',
      createdAt: time,
    },
  ]
  let knowledge: KnowledgeBase = {
    id: 'filled-knowledge',
    name: '合成知识库',
    description: '用于浏览器差分的合成知识库',
    enabled: true,
    version: 7,
    assetIds: ['filled-asset'],
    createdAt: time,
    updatedAt: time,
  }
  const tool = {
    id: 'required-tool',
    name: '合成依赖工具',
    description: '阶段技能需要此工具',
    enabled: true,
    version: 2,
    createdAt: time,
    updatedAt: time,
    settings: {},
  }
  const skill = {
    id: 'filled-skill',
    name: '合成阶段技能',
    description: '选中后加入依赖工具',
    enabled: true,
    version: 3,
    createdAt: time,
    updatedAt: time,
    instructions: '仅处理合成内容',
    requiredToolIds: [tool.id],
    program: { schemaVersion: 1, stages: [] },
  }
  const agent: AgentDefinition = {
    id: 'filled-agent',
    name: '合成智能体',
    description: '用于测试关联选择',
    instructions: '按合成资源回答',
    recommendedPrompts: ['合成任务'],
    inputRequirements: [],
    outputExamples: [],
    knowledgeBaseIds: [knowledge.id],
    knowledgeAssetIds: [],
    templateAssetIds: [],
    skillIds: [],
    toolIds: [],
    published: true,
    version: 4,
    createdAt: time,
    updatedAt: time,
  }
  const files: FileEntry[] = Array.from({ length: 13 }, (_, index) => ({
    id: `filled-file-${index + 1}`,
    ownerUserId: 'parity-admin',
    name: `合成文件${String(index + 1).padStart(2, '0')}.txt`,
    size: index + 9,
    sha256: `synthetic-${index}`,
    mediaType: 'text/plain',
    category: 'document',
    version: 1,
    previousFileId: null,
    storageId: 'local',
    createdAt: time,
    deletedAt: null,
    references: [],
  }))
  const state = {
    operations: [] as { method: string; path: string; body: unknown }[],
    reads: [] as { path: string; query: Record<string, string> }[],
    conflict: false,
    filesForbidden: false,
    indexed: 0,
    uploaded: 0,
    get knowledge() {
      return knowledge
    },
  }
  const routePaths = new Set([
    '/admin/agents/catalog',
    '/admin/agents',
    '/admin/agents/filled-agent',
    '/admin/agents/assets',
    '/admin/knowledge-bases',
    '/admin/knowledge-bases/filled-knowledge',
    '/admin/knowledge-bases/filled-knowledge/index',
    '/files',
    ...files.flatMap((file) => [
      '/files/' + file.id + '/trash',
      '/files/' + file.id + '/restore',
    ]),
  ])
  await page.route(
    (url) => routePaths.has(url.pathname.replace(/^\/api(?:\/v2)?/, '')),
    async (route) => {
      const request = route.request(),
        url = new URL(request.url()),
        path = url.pathname.replace(/^\/api(?:\/v2)?/, ''),
        method = request.method()
      const json = (body: unknown, status = 200) =>
        route.fulfill({ status, json: body })
      if (method === 'GET') {
        state.reads.push({ path, query: Object.fromEntries(url.searchParams) })
        if (path === '/admin/agents/catalog')
          return json({
            assets,
            knowledgeBases: [knowledge],
            skills: [skill],
            tools: [tool],
          })
        if (path === '/admin/agents')
          return json({ items: [agent], total: 1, page: 1, pageSize: 10 })
        if (path === '/admin/knowledge-bases')
          return json({ items: [knowledge], total: 1, page: 1, pageSize: 10 })
        if (path === '/admin/knowledge-bases/filled-knowledge/index')
          return json({ items: [] })
        if (path === '/files') {
          if (state.filesForbidden)
            return json(
              { detail: '文件读取权限已撤销', code: 'forbidden' },
              403,
            )
          const currentPage = Math.max(
              1,
              Number(url.searchParams.get('page') ?? 1),
            ),
            size = Number(url.searchParams.get('pageSize') ?? 10),
            query =
              url.searchParams.get('search') ?? url.searchParams.get('q') ?? '',
            trash =
              (url.searchParams.get('deleted') ??
                url.searchParams.get('trash')) === 'true'
          const found = files.filter(
            (file) =>
              file.name.includes(query) && Boolean(file.deletedAt) === trash,
          )
          return json({
            items: found.slice((currentPage - 1) * size, currentPage * size),
            total: found.length,
            page: currentPage,
            pageSize: size,
          })
        }
      } else {
        const body: unknown = request.postData() ? request.postDataJSON() : null
        state.operations.push({ method, path, body })
        const fileAction = /^\/files\/([^/]+)\/(trash|restore)$/.exec(path)
        if (fileAction && method === 'POST') {
          if (
            options.permissions &&
            !options.permissions.includes('files.write')
          )
            return json({ detail: '缺少文件写入权限' }, 403)
          const file = files.find((item) => item.id === fileAction[1])
          if (!file) return json({ detail: '文件不存在' }, 404)
          file.deletedAt = fileAction[2] === 'trash' ? time : null
          return json(file)
        }
        if (
          path === '/admin/knowledge-bases/filled-knowledge' &&
          method === 'PUT'
        ) {
          if (state.conflict)
            return json(
              {
                detail: '版本冲突：请刷新知识库后重试',
                code: 'version_conflict',
              },
              409,
            )
          const value = body as { version?: number; assetIds?: string[] }
          if (
            value.version !== knowledge.version ||
            !Array.isArray(value.assetIds)
          )
            return json({ detail: '合成请求版本或关联字段不正确' }, 409)
          knowledge = {
            ...knowledge,
            assetIds: [...value.assetIds],
            version: knowledge.version + 1,
          }
          return json({ knowledgeBase: knowledge })
        }
        if (path === '/admin/agents/assets' && method === 'POST') {
          const value = body as {
            name?: string
            kind?: AgentAsset['kind']
            contentBase64?: string
          }
          if (!value.name?.trim() || !value.contentBase64 || !value.kind)
            return json({ detail: '合成上传缺少内容' }, 400)
          state.uploaded += 1
          const asset: AgentAsset = {
            ...assets[0]!,
            id: `uploaded-${state.uploaded}`,
            name: value.name,
            kind: value.kind,
          }
          assets.push(asset)
          return json({ asset })
        }
        if (
          path === '/admin/knowledge-bases/filled-knowledge/index' &&
          method === 'POST'
        ) {
          state.indexed += 1
          return json({
            indexedAssets: knowledge.assetIds.length,
            chunks: knowledge.assetIds.length,
          })
        }
      }
      return json({ detail: `合成场景未授权 ${method} ${path}` }, 405)
    },
  )
  return state
}

/** 有状态资源场景只在本次浏览器 context 内存中存在。 */
export type ResourceFixture = Awaited<ReturnType<typeof installResourceFixture>>
