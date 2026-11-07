'use client'

import * as React from 'react'
import type { ToolImplementationRef } from '@superdsh/core/contracts/extensions'
import { extensionsApi } from '@/features/agents/extensions-api'
import { ToolSourcesDialog } from './tool-sources-dialog'
import { ToolImplementationEditor } from './tool-implementation-editor'
import { SkillImportDialog } from './skill-import-dialog'
import { AgentResourceHistory } from './agent-resource-history'
import { useAuth } from '@/components/auth/auth-context'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { agentsApi, type AgentAsset } from '@/features/agents/api'
import {
  knowledgeBasesApi,
  agentSkillsApi,
  agentToolsApi,
  type AgentResource,
  type KnowledgeBase,
  type AgentSkill,
  type AgentTool,
  type ResourcePage,
} from '@/features/agents/resources-api'
import { sessionIdentityRevision } from '@/features/auth/session'
import {
  dateLabel,
  FieldLabel,
  ResourceState,
  tableClass,
  useManagementResource,
  useManagementText,
} from './controls'
import {
  ManagementDialog,
  ManagementList,
  ManagementPagination,
} from './presentation'
import { AgentAssetsPanel } from './agent-assets-panel'
import { KnowledgeSearchSettings } from './knowledge-search-settings'
import { KnowledgeIndexDialog } from './knowledge-index-dialog'
import { SkillProgramEditor } from './skill-program-editor'
import type { SkillProgram } from '@superdsh/core/contracts/skills'

type Kind = 'knowledge' | 'skills' | 'tools'
type Resource = KnowledgeBase | AgentSkill | AgentTool
type Draft = {
  programDraft?: SkillProgram | null
  name: string
  description: string
  enabled: boolean
  version?: number
  assetIds: string[]
  instructions: string
  requiredToolIds: string[]
  settings: AgentTool['settings']
  implementation?: ToolImplementationRef
}

function draftFor(resource?: Resource): Draft {
  return {
    ...(resource && 'requiredToolIds' in resource
      ? { programDraft: resource.programDraft ?? resource.program }
      : {}),
    name: resource?.name ?? '',
    description: resource?.description ?? '',
    enabled: resource?.enabled ?? true,
    version: resource?.version,
    assetIds: resource && 'assetIds' in resource ? [...resource.assetIds] : [],
    instructions:
      resource && 'instructions' in resource ? resource.instructions : '',
    requiredToolIds:
      resource && 'requiredToolIds' in resource
        ? [...resource.requiredToolIds]
        : [],
    implementation:
      resource && 'settings' in resource ? resource.implementation : undefined,
    settings:
      resource && 'settings' in resource ? { ...resource.settings } : {},
  }
}

export function AgentResourceManager({ kind }: { kind: Kind }) {
  const { session, can } = useAuth()
  const tr = useManagementText()
  if (!can('agents.manage'))
    return (
      <p role="alert">
        {tr(
          '当前账号没有资源管理权限。',
          'This account cannot manage agent resources.',
        )}
      </p>
    )
  return (
    <ScopedResourceManager
      key={`${kind}:${session?.userId}:${session?.authzVersion}`}
      kind={kind}
    />
  )
}

function ScopedResourceManager({ kind }: { kind: Kind }) {
  const tr = useManagementText()
  const { can } = useAuth()
  const [sourcesOpen, setSourcesOpen] = React.useState(false)
  const [historyItem, setHistoryItem] = React.useState<Resource | null>(null)
  const [importOpen, setImportOpen] = React.useState(false)
  const [matchOpen, setMatchOpen] = React.useState(false)
  const [matchRequest, setMatchRequest] = React.useState('')
  const [matchResult, setMatchResult] = React.useState<Awaited<
    ReturnType<typeof agentSkillsApi.matchPreview>
  > | null>(null)
  const extensions = useManagementResource(
    'tool-implementations',
    extensionsApi.list,
    { enabled: kind === 'tools' },
  )
  const [embeddingSettings, setEmbeddingSettings] = React.useState(false)
  const [knowledgeDiagnostics, setKnowledgeDiagnostics] =
    React.useState<KnowledgeBase | null>(null)
  const label =
    kind === 'knowledge'
      ? tr('知识库', 'knowledge base')
      : kind === 'skills'
        ? tr('技能', 'skill')
        : tr('工具', 'tool')
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(10)
  const [query, setQuery] = React.useState('')
  const [search, setSearch] = React.useState('')
  const api =
    kind === 'knowledge'
      ? knowledgeBasesApi
      : kind === 'skills'
        ? agentSkillsApi
        : agentToolsApi
  const resource = useManagementResource<ResourcePage<Resource>>(
    `${kind}:${page}:${pageSize}:${search}`,
    () => api.list(page, pageSize, search),
  )
  const catalog = useManagementResource(
    `resource-catalog:${kind}`,
    agentsApi.catalog,
  )
  const searchStatus = useManagementResource(
    'knowledge-search-status',
    knowledgeBasesApi.searchStatus,
    { enabled: kind === 'knowledge' },
  )
  const [indexing, setIndexing] = React.useState<string | null>(null)
  const [indexMessage, setIndexMessage] = React.useState('')
  const [indexError, setIndexError] = React.useState<{
    id: string
    message: string
  } | null>(null)
  const [editing, setEditing] = React.useState<Resource | 'new' | null>(null)
  const [draft, setDraft] = React.useState(() => draftFor())
  const [deleting, setDeleting] = React.useState<Resource | null>(null)
  const [fileBase, setFileBase] = React.useState<KnowledgeBase | null>(null)
  const [fileError, setFileError] = React.useState('')
  const [fileBusy, setFileBusy] = React.useState(false)
  const mounted = React.useRef(true)
  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const formId = React.useId()
  const total = resource.data?.total ?? 0
  React.useEffect(() => {
    if (resource.data && !resource.loading)
      setPage((current) =>
        Math.min(current, Math.max(1, Math.ceil(total / pageSize))),
      )
  }, [resource.data, resource.loading, total, pageSize])
  const openEditor = (entry: Resource | 'new') => {
    setDraft(draftFor(entry === 'new' ? undefined : entry))
    setEditing(entry)
    catalog.reload()
  }
  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!editing || resource.busy) return
    const common = {
      name: draft.name.trim(),
      description: draft.description.trim(),
      enabled: draft.enabled,
      version: draft.version,
    }
    const id = editing === 'new' ? null : editing.id
    const ok = await resource.perform(() => {
      if (kind === 'knowledge')
        return knowledgeBasesApi.save(id, {
          ...common,
          assetIds: draft.assetIds,
        })
      if (kind === 'skills')
        return agentSkillsApi.save(id, {
          ...common,
          instructions: draft.instructions.trim(),
          requiredToolIds: draft.requiredToolIds,
          programDraft: draft.programDraft,
          ...(editing !== 'new' && 'references' in editing
            ? {
                references: editing.references,
                packageSha256: (editing as AgentSkill).packageSha256,
              }
            : {}),
        })
      return agentToolsApi.save(id, {
        ...common,
        settings: draft.settings,
        implementation: draft.implementation,
      })
    })
    if (ok) {
      setEditing(null)
      catalog.reload()
    }
  }
  const updateFiles = async (assetIds: string[]) => {
    if (!fileBase) return
    const identity = sessionIdentityRevision()
    setFileBusy(true)
    setFileError('')
    try {
      await knowledgeBasesApi.save(fileBase.id, {
        name: fileBase.name,
        description: fileBase.description,
        enabled: fileBase.enabled,
        version: fileBase.version,
        assetIds,
      })
      const nextCatalog = await agentsApi.catalog()
      if (!mounted.current || identity !== sessionIdentityRevision()) return
      setFileBase(
        nextCatalog.knowledgeBases.find((item) => item.id === fileBase.id) ??
          null,
      )
      resource.reload()
      catalog.reload()
      await reindex(fileBase.id)
    } catch (error) {
      if (mounted.current && identity === sessionIdentityRevision())
        setFileError(error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      if (mounted.current && identity === sessionIdentityRevision())
        setFileBusy(false)
    }
  }
  const reindex = async (id: string) => {
    if (indexing) return
    const identity = sessionIdentityRevision()
    setIndexing(id)
    setIndexMessage('')
    setIndexError(null)
    try {
      const result = await knowledgeBasesApi.index(id)
      if (mounted.current && identity === sessionIdentityRevision())
        setIndexMessage(
          tr(
            `已索引 ${result.indexedAssets} 份资料、${result.chunks} 个内容段落。`,
            `Indexed ${result.indexedAssets} resources and ${result.chunks} passages.`,
          ),
        )
    } catch (error) {
      if (mounted.current && identity === sessionIdentityRevision())
        setIndexError({
          id,
          message:
            tr(
              '资料已保存，检索索引更新失败：',
              'Resources are saved, but search indexing failed: ',
            ) + (error instanceof Error ? error.message : String(error)),
        })
    } finally {
      if (mounted.current && identity === sessionIdentityRevision()) {
        setIndexing(null)
        searchStatus.reload()
      }
    }
  }
  const descriptions = {
    knowledge: tr(
      '按业务组织公司资料与 Excel/PPT 模板，再由智能体关联。示例资料均为虚构、脱敏内容。',
      'Organize company resources and Excel/PPT templates by business purpose, then link them to agents. Sample resources are fictional and anonymized.',
    ),
    skills: tr(
      '独立维护业务步骤、输出要求和依赖工具。修改后用于新的智能体会话，已有会话保留原配置。',
      'Maintain reusable instructions, output requirements and required tools. Changes apply to new agent sessions; existing sessions keep their original configuration.',
    ),
    tools: tr(
      '从已安装扩展或已授权 MCP 创建工具配置，再关联到技能和智能体。参数、凭据及实现版本独立管理。',
      'Configure installed extensions and approved MCP tools, then link them to skills and agents. Settings, credentials and implementation versions are managed separately.',
    ),
  }
  return (
    <ManagementList
      className="gap-5"
      pagination={
        <ManagementPagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size)
            setPage(1)
          }}
          loading={resource.loading}
        />
      }
    >
      <p className="text-sm text-muted-foreground">{descriptions[kind]}</p>
      {kind === 'skills' && (
        <div className="flex justify-end">
          <Button variant="outline" onClick={() => setMatchOpen(true)}>
            匹配试验
          </Button>
        </div>
      )}
      <ManagementDialog
        open={matchOpen}
        onOpenChange={setMatchOpen}
        title="技能匹配试验"
        description="仅检查已发布技能的匹配条件，不生成文件或调用收费模型。"
        busy={resource.busy}
        error={resource.error}
      >
        <Textarea
          aria-label="试验需求"
          value={matchRequest}
          onChange={(e) => setMatchRequest(e.target.value)}
          placeholder="例如：制作一份客户培训 PPT"
        />
        <Button
          className="mt-3"
          disabled={resource.busy || !matchRequest.trim()}
          onClick={() =>
            void resource.perform(async () => {
              setMatchResult(await agentSkillsApi.matchPreview(matchRequest))
            })
          }
        >
          检查匹配
        </Button>
        <ul className="mt-3 space-y-2">
          {matchResult?.candidates.map((item) => (
            <li key={item.id}>
              {item.name} · {item.score < 0 ? '不适用' : `${item.score} 分`}
              <p className="text-xs text-muted-foreground">
                {item.reasons.join('；') ||
                  '未命中词项，运行时由当前模型结合需求判断'}
              </p>
            </li>
          ))}
        </ul>
      </ManagementDialog>
      {kind === 'tools' && (
        <div className="flex justify-end">
          <Button variant="outline" onClick={() => setSourcesOpen(true)}>
            扩展来源与 MCP
          </Button>
        </div>
      )}
      {sourcesOpen && (
        <ToolSourcesDialog
          onClose={() => setSourcesOpen(false)}
          onUpdated={() => {
            extensions.reload()
            resource.reload()
          }}
        />
      )}
      {importOpen && (
        <SkillImportDialog
          tools={catalog.data?.tools ?? []}
          onClose={() => setImportOpen(false)}
          onImported={() => {
            resource.reload()
            catalog.reload()
            setImportOpen(false)
          }}
        />
      )}
      {kind === 'knowledge' && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card px-4 py-3 text-sm">
          <span
            className={`h-2 w-2 rounded-full ${searchStatus.data?.ready ? 'bg-emerald-500' : 'bg-amber-500'}`}
          />
          <span className="font-medium">Qdrant</span>
          <span className="flex-1 text-muted-foreground">
            {searchStatus.loading
              ? tr('正在检查检索服务…', 'Checking search service…')
              : searchStatus.error ||
                searchStatus.data?.message ||
                tr('检索服务未就绪', 'Search service is not ready')}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={searchStatus.loading}
            onClick={searchStatus.reload}
          >
            {tr('检查连接', 'Check connection')}
          </Button>
          {can('models.manage') && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEmbeddingSettings(true)}
            >
              {tr('检索设置', 'Search settings')}
            </Button>
          )}
        </div>
      )}
      {embeddingSettings && (
        <KnowledgeSearchSettings
          onClose={() => setEmbeddingSettings(false)}
          onUpdated={searchStatus.reload}
        />
      )}
      {knowledgeDiagnostics && (
        <KnowledgeIndexDialog
          key={knowledgeDiagnostics.id}
          id={knowledgeDiagnostics.id}
          name={knowledgeDiagnostics.name}
          onClose={() => setKnowledgeDiagnostics(null)}
        />
      )}
      {indexMessage && (
        <p role="status" className="text-sm text-muted-foreground">
          {indexMessage}
        </p>
      )}
      {indexError && (
        <ResourceState
          loading={false}
          error={indexError.message}
          onRetry={() => void reindex(indexError.id)}
        />
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            setSearch(query.trim())
            setPage(1)
          }}
        >
          <Input
            aria-label={tr(`搜索${label}`, `Search ${label}`)}
            placeholder={tr('搜索名称', 'Search name')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Button variant="outline" type="submit">
            {tr('搜索', 'Search')}
          </Button>
        </form>
        <div className="flex gap-2">
          {kind === 'skills' && (
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              导入技能包
            </Button>
          )}
          <Button
            disabled={resource.busy || resource.loading}
            onClick={() => openEditor('new')}
          >
            {tr(`新增${label}`, `Create ${label}`)}
          </Button>
        </div>
      </div>
      <ResourceState
        loading={resource.loading}
        error={resource.error}
        onRetry={resource.reload}
      />
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className={tableClass}>
          <thead>
            <tr>
              <th>{tr('名称与用途', 'Name and purpose')}</th>
              <th>{tr('状态', 'Status')}</th>
              <th>{tr('配置', 'Configuration')}</th>
              <th>{tr('最近更新', 'Updated')}</th>
              <th>{tr('操作', 'Actions')}</th>
            </tr>
          </thead>
          <tbody>
            {(resource.data?.items ?? []).map((item) => (
              <tr key={item.id}>
                <td>
                  <p className="font-medium">{item.name}</p>
                  <p className="mt-1 max-w-md text-xs text-muted-foreground">
                    {item.description}
                  </p>
                </td>
                <td>
                  <span className="inline-flex rounded-full border px-2 py-1 text-xs">
                    {item.enabled
                      ? tr('已启用', 'Enabled')
                      : tr('已停用', 'Disabled')}
                  </span>
                </td>
                <td className="text-xs text-muted-foreground">
                  {'assetIds' in item ? (
                    tr(
                      `${item.assetIds.length} 份资料 / 模板`,
                      `${item.assetIds.length} resources / templates`,
                    )
                  ) : 'requiredToolIds' in item ? (
                    tr(
                      `依赖 ${item.requiredToolIds.length} 个工具`,
                      `${item.requiredToolIds.length} required tools`,
                    )
                  ) : (
                    <>
                      <p>
                        {item.implementation?.sourceId ??
                          tr('内置实现', 'Built-in implementation')}
                      </p>
                      <code className="text-xs">
                        {item.implementation
                          ? `${item.implementation.toolId} @ ${item.implementation.version}`
                          : item.id}
                      </code>
                    </>
                  )}
                  <p className="mt-1">v{item.version}</p>
                  {'requiredToolIds' in item && (
                    <p>
                      {item.program
                        ? `${item.program.stages.length} 个阶段 · 已发布`
                        : '单项方法技能'}
                      {item.programDraft ? ' · 有待发布草稿' : ''}
                    </p>
                  )}
                </td>
                <td>{dateLabel(item.updatedAt)}</td>
                <td>
                  <div className="flex flex-wrap gap-2">
                    {'assetIds' in item && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setFileBase(item)
                          setFileError('')
                          catalog.reload()
                        }}
                      >
                        {tr('管理文件', 'Manage files')}
                      </Button>
                    )}
                    {'assetIds' in item && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setKnowledgeDiagnostics(item)}
                      >
                        {tr('索引与检索', 'Index and search')}
                      </Button>
                    )}
                    {'assetIds' in item && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!!indexing}
                        onClick={() => void reindex(item.id)}
                      >
                        {indexing === item.id
                          ? tr('索引中…', 'Indexing…')
                          : tr('重建索引', 'Rebuild index')}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => openEditor(item)}
                    >
                      {tr('编辑', 'Edit')}
                    </Button>
                    {'requiredToolIds' in item && item.programDraft && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={resource.busy}
                        onClick={() =>
                          void resource.perform(async () => {
                            await agentSkillsApi.publish(item.id, item.version)
                            catalog.reload()
                          })
                        }
                      >
                        发布阶段配置
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setHistoryItem(item)}
                    >
                      {tr('版本记录', 'Versions')}
                    </Button>
                    {
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={resource.busy}
                        onClick={() => setDeleting(item)}
                      >
                        {tr('删除', 'Delete')}
                      </Button>
                    }
                  </div>
                </td>
              </tr>
            ))}
            {!resource.loading && resource.data?.items.length === 0 && (
              <tr>
                <td colSpan={5} className="text-muted-foreground">
                  {tr(`暂无${label}。`, `No ${label}s found.`)}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {historyItem && (
        <AgentResourceHistory
          item={historyItem}
          api={api}
          onClose={() => setHistoryItem(null)}
          onRestored={() => {
            resource.reload()
            catalog.reload()
          }}
        />
      )}
      <ManagementDialog
        open={!!editing}
        onOpenChange={(open) => !open && setEditing(null)}
        title={
          editing === 'new'
            ? tr(`新增${label}`, `Create ${label}`)
            : tr(`编辑${label}`, `Edit ${label}`)
        }
        busy={resource.busy}
        error={resource.error}
        className="sm:max-w-2xl"
        footer={
          <>
            <Button
              variant="outline"
              disabled={resource.busy}
              onClick={() => setEditing(null)}
            >
              {tr('取消', 'Cancel')}
            </Button>
            <Button
              type="submit"
              form={formId}
              disabled={
                resource.busy ||
                (kind !== 'tools' && (catalog.loading || !!catalog.error))
              }
            >
              {resource.busy ? tr('保存中…', 'Saving…') : tr('保存', 'Save')}
            </Button>
          </>
        }
      >
        <form id={formId} onSubmit={save} className="space-y-4">
          <fieldset disabled={resource.busy} className="space-y-4">
            <FieldLabel title={tr('名称', 'Name')}>
              <Input
                required
                maxLength={80}
                value={draft.name}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
              />
            </FieldLabel>
            <FieldLabel title={tr('用途说明', 'Purpose')}>
              <Textarea
                required
                maxLength={500}
                value={draft.description}
                onChange={(event) =>
                  setDraft({ ...draft, description: event.target.value })
                }
              />
            </FieldLabel>
            {kind !== 'tools' && (
              <ResourceState
                loading={catalog.loading}
                error={catalog.error}
                onRetry={catalog.reload}
              />
            )}
            {kind === 'knowledge' && (
              <ResourceChoices
                title={tr('资料与模板', 'Resources and templates')}
                items={(catalog.data?.assets ?? []).map((asset) => ({
                  id: asset.id,
                  name: asset.name,
                  description:
                    asset.kind === 'knowledge'
                      ? tr('知识资料', 'Knowledge')
                      : asset.kind === 'spreadsheet-template'
                        ? 'Excel'
                        : 'PPT',
                }))}
                selected={draft.assetIds}
                onChange={(assetIds) => setDraft({ ...draft, assetIds })}
                empty={tr(
                  '暂无资料，保存知识库后点击“管理文件”上传。',
                  'No resources yet. Save this knowledge base, then use Manage files to upload.',
                )}
              />
            )}
            {kind === 'skills' && (
              <>
                <SkillProgramEditor
                  value={draft.programDraft}
                  tools={catalog.data?.tools ?? []}
                  skills={catalog.data?.skills ?? []}
                  onChange={(programDraft) =>
                    setDraft({
                      ...draft,
                      programDraft,
                      requiredToolIds: [
                        ...new Set([
                          ...draft.requiredToolIds,
                          ...(programDraft?.stages.flatMap((stage) => [
                            ...stage.toolIds,
                            ...(catalog.data?.skills.find(
                              (skill) => skill.id === stage.skillId,
                            )?.requiredToolIds ?? []),
                          ]) ?? []),
                        ]),
                      ],
                    })
                  }
                />
                <FieldLabel title={tr('执行要求', 'Instructions')}>
                  <Textarea
                    required
                    rows={8}
                    maxLength={12000}
                    value={draft.instructions}
                    onChange={(event) =>
                      setDraft({ ...draft, instructions: event.target.value })
                    }
                    placeholder={tr(
                      '写清业务步骤、输入、输出格式与注意事项。',
                      'Describe the business steps, inputs, output format and requirements.',
                    )}
                  />
                </FieldLabel>
                <ResourceChoices
                  title={tr('依赖工具', 'Required tools')}
                  items={catalog.data?.tools ?? []}
                  selected={draft.requiredToolIds}
                  onChange={(requiredToolIds) =>
                    setDraft({ ...draft, requiredToolIds })
                  }
                  empty={tr('暂无工具。', 'No tools available.')}
                />
              </>
            )}
            {kind === 'tools' && (
              <>
                <ResourceState
                  loading={extensions.loading}
                  error={extensions.error}
                  onRetry={extensions.reload}
                />
                <ToolImplementationEditor
                  sources={extensions.data?.items ?? []}
                  implementation={draft.implementation}
                  settings={draft.settings}
                  existing={
                    editing && editing !== 'new' && 'settings' in editing
                      ? editing
                      : undefined
                  }
                  onSelect={(implementation, settings) =>
                    setDraft({ ...draft, implementation, settings })
                  }
                  onSettings={(settings) => setDraft({ ...draft, settings })}
                />
              </>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="accent-primary"
                checked={draft.enabled}
                onChange={(event) =>
                  setDraft({ ...draft, enabled: event.target.checked })
                }
              />
              {tr(
                '启用工具或资源；停用将阻止后续调用',
                'Enable this resource; disabling blocks subsequent calls',
              )}
            </label>
          </fieldset>
        </form>
      </ManagementDialog>
      <ManagementDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={tr(`删除${label}`, `Delete ${label}`)}
        description={tr(
          `确认删除「${deleting?.name ?? ''}」？若仍有智能体关联，请先调整关联。`,
          `Delete ${deleting?.name ?? ''}? Remove any agent references first.`,
        )}
        busy={resource.busy}
        error={resource.error}
        footer={
          <>
            <Button
              variant="outline"
              disabled={resource.busy}
              onClick={() => setDeleting(null)}
            >
              {tr('取消', 'Cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={resource.busy}
              onClick={async () => {
                if (
                  deleting &&
                  (await resource.perform(() =>
                    kind === 'knowledge'
                      ? knowledgeBasesApi.remove(deleting.id)
                      : kind === 'tools'
                        ? agentToolsApi.remove(deleting.id)
                        : agentSkillsApi.remove(deleting.id),
                  ))
                ) {
                  setDeleting(null)
                  catalog.reload()
                }
              }}
            >
              {tr('删除', 'Delete')}
            </Button>
          </>
        }
      />
      <ManagementDialog
        open={!!fileBase}
        onOpenChange={(open) => !open && setFileBase(null)}
        title={tr(
          `管理文件 · ${fileBase?.name ?? ''}`,
          `Manage files · ${fileBase?.name ?? ''}`,
        )}
        description={tr(
          '上传的资料将自动加入当前知识库；移出只解除关联，原文件和已有会话不受影响。',
          'Uploaded files are added to this knowledge base. Removing a link preserves the original file and existing sessions.',
        )}
        busy={fileBusy}
        className="sm:max-w-5xl"
      >
        {fileBase && (
          <div className="mb-3 flex justify-end">
            <Button
              size="sm"
              variant="outline"
              disabled={!!indexing || fileBusy}
              onClick={() => void reindex(fileBase.id)}
            >
              {indexing === fileBase.id
                ? tr('索引中…', 'Indexing…')
                : tr('重建索引', 'Rebuild index')}
            </Button>
          </div>
        )}
        <ResourceState
          loading={catalog.loading}
          error={fileError || catalog.error}
          onRetry={() => {
            setFileError('')
            catalog.reload()
          }}
        />
        {indexError && indexError.id === fileBase?.id && (
          <ResourceState
            loading={false}
            error={indexError.message}
            onRetry={() => void reindex(indexError.id)}
          />
        )}
        {indexMessage && (
          <p role="status" className="text-sm text-muted-foreground">
            {indexMessage}
          </p>
        )}
        {fileBase && (
          <AgentAssetsPanel
            assets={(catalog.data?.assets ?? []).filter((asset) =>
              fileBase.assetIds.includes(asset.id),
            )}
            onUploaded={(asset: AgentAsset) =>
              updateFiles([...new Set([...fileBase.assetIds, asset.id])])
            }
            onRemove={(asset) =>
              updateFiles(fileBase.assetIds.filter((id) => id !== asset.id))
            }
            disabled={fileBusy || catalog.loading || !!indexing}
          />
        )}
      </ManagementDialog>
    </ManagementList>
  )
}

function ResourceChoices({
  title,
  items,
  selected,
  onChange,
  empty,
}: {
  title: string
  items: (Pick<AgentResource, 'id' | 'name' | 'description'> & {
    enabled?: boolean
  })[]
  selected: string[]
  onChange: (ids: string[]) => void
  empty: string
}) {
  const tr = useManagementText()
  return (
    <fieldset className="rounded-xl border p-3">
      <legend className="px-1 text-sm font-medium">{title}</legend>
      <div className="max-h-60 space-y-2 overflow-y-auto">
        {!items.length && (
          <p className="text-xs text-muted-foreground">{empty}</p>
        )}
        {items.map((item) => (
          <label
            key={item.id}
            className="flex cursor-pointer items-start gap-2 rounded-lg p-2 hover:bg-muted/50"
          >
            <input
              type="checkbox"
              className="mt-1 accent-primary"
              checked={selected.includes(item.id)}
              disabled={item.enabled === false && !selected.includes(item.id)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, item.id]
                    : selected.filter((id) => id !== item.id),
                )
              }
            />
            <span className="text-sm">
              <span className="block font-medium">
                {item.name}
                {item.enabled === false ? tr('（已停用）', ' (disabled)') : ''}
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {item.description}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}
