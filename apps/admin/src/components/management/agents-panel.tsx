'use client'

import * as React from 'react'
import { useAuth } from '@/components/auth/auth-context'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  agentsApi,
  editableAgent,
  emptyAgentDefinition,
  type AgentDefinition,
} from '@/features/agents/api'
import {
  dateLabel,
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
import { AgentDefinitionEditor } from './agent-definition-editor'
import { stageAgentTrial } from '@/features/agents/trial'

export function AgentsPanel() {
  const { session, can } = useAuth()
  const tr = useManagementText()
  if (!can('agents.manage'))
    return (
      <p role="alert">
        {tr(
          '当前账号没有智能体管理权限。',
          'This account cannot manage agents.',
        )}
      </p>
    )
  return (
    <ScopedAgentsPanel key={`${session?.userId}:${session?.authzVersion}`} />
  )
}

function ScopedAgentsPanel() {
  const tr = useManagementText()
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(10)
  const [query, setQuery] = React.useState('')
  const [search, setSearch] = React.useState('')
  const resource = useManagementResource(
    `agents:${page}:${pageSize}:${search}`,
    () => agentsApi.list(page, pageSize, search),
  )
  const catalog = useManagementResource('agent-catalog', agentsApi.catalog)
  const [editing, setEditing] = React.useState<AgentDefinition | 'new' | null>(
    null,
  )
  const [draft, setDraft] = React.useState(emptyAgentDefinition)
  const [validationError, setValidationError] = React.useState('')
  const [deleting, setDeleting] = React.useState<AgentDefinition | null>(null)
  const [checking, setChecking] = React.useState<AgentDefinition | null>(null)
  const [copyingExamples, setCopyingExamples] = React.useState(false)
  const [trialError, setTrialError] = React.useState('')
  const readiness = useManagementResource(
    `agent-readiness:${checking?.id}:${checking?.version}`,
    () => agentsApi.readiness(checking!.id),
    { enabled: !!checking },
  )
  const trial = (agent: AgentDefinition) => {
    const status = stageAgentTrial(agent)
    setTrialError(
      status === 'draft'
        ? tr(
            '工作台已有未发送草稿或附件，请先处理后再试用，原草稿已保留。',
            'The workspace has an unsent draft or attachment. Resolve it before trying this agent; your draft is unchanged.',
          )
        : status === 'busy'
          ? tr(
              '工作台正在创建会话，请稍后再试用。',
              'A session is being created. Try again once it finishes.',
            )
          : status === 'unpublished'
            ? tr(
                '请先发布，再从工作台试用。',
                'Publish this agent before trying it in the workspace.',
              )
            : '',
    )
  }
  const total = resource.data?.total ?? 0
  React.useEffect(() => {
    if (resource.data && !resource.loading)
      setPage((current) =>
        Math.min(current, Math.max(1, Math.ceil(total / pageSize))),
      )
  }, [resource.data, resource.loading, total, pageSize])
  const openEditor = (agent: AgentDefinition | 'new') => {
    setDraft(agent === 'new' ? emptyAgentDefinition() : editableAgent(agent))
    setValidationError('')
    setEditing(agent)
  }
  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!editing || resource.busy) return
    if (
      !draft.name.trim() ||
      !draft.description.trim() ||
      !draft.instructions.trim()
    ) {
      setValidationError(
        tr(
          '请填写名称、用途说明和工作要求。',
          'Enter a name, purpose and instructions.',
        ),
      )
      return
    }
    const ok = await resource.perform(() =>
      agentsApi.save(editing === 'new' ? null : editing.id, {
        ...draft,
        name: draft.name.trim(),
        description: draft.description.trim(),
        instructions: draft.instructions.trim(),
        recommendedPrompts: (draft.recommendedPrompts ?? [])
          .map((value) => value.trim())
          .filter(Boolean),
        inputRequirements: (draft.inputRequirements ?? [])
          .map((value) => value.trim())
          .filter(Boolean),
        outputExamples: (draft.outputExamples ?? [])
          .map((value) => value.trim())
          .filter(Boolean),
      }),
    )
    if (ok) setEditing(null)
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
      <p className="text-sm text-muted-foreground">
        {tr(
          '关联知识库、技能和工具，发布到主工作台。首次使用会准备四个脱敏示例，可直接编辑或创建自己的智能体。',
          'Combine knowledge bases, skills and tools for the workspace. First use prepares four anonymized examples to edit, or create your own agent.',
        )}
      </p>
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
            aria-label={tr('搜索智能体', 'Search agents')}
            placeholder={tr('搜索名称', 'Search name')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Button variant="outline" type="submit">
            {tr('搜索', 'Search')}
          </Button>
        </form>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={resource.busy}
            onClick={() => setCopyingExamples(true)}
          >
            {tr('复制新版示例', 'Copy latest examples')}
          </Button>
          <Button disabled={resource.busy} onClick={() => openEditor('new')}>
            {tr('新增智能体', 'Create agent')}
          </Button>
        </div>
      </div>
      <ResourceState
        loading={resource.loading}
        error={resource.error}
        onRetry={resource.reload}
      />
      {!!trialError && (
        <p role="alert" className="text-sm text-destructive">
          {trialError}
        </p>
      )}
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
            {(resource.data?.items ?? []).map((agent) => (
              <tr key={agent.id}>
                <td>
                  <p className="font-medium">{agent.name}</p>
                  <p className="mt-1 max-w-md text-xs text-muted-foreground">
                    {agent.description}
                  </p>
                  {!!agent.recommendedPrompts?.length && (
                    <p className="mt-2 max-w-md text-xs text-muted-foreground">
                      {tr('试用指令：', 'Try: ')}
                      {agent.recommendedPrompts[0]}
                    </p>
                  )}
                </td>
                <td>
                  <span className="inline-flex rounded-full border px-2 py-1 text-xs">
                    {agent.published
                      ? tr('已发布', 'Published')
                      : tr('草稿', 'Draft')}
                  </span>
                  <p className="mt-1 text-xs text-muted-foreground">
                    v{agent.version}
                  </p>
                </td>
                <td className="text-xs text-muted-foreground">
                  <p>
                    {tr(
                      `知识库 ${agent.knowledgeBaseIds?.length ?? 0} · 直接资料 ${agent.knowledgeAssetIds.length + agent.templateAssetIds.length}`,
                      `${agent.knowledgeBaseIds?.length ?? 0} knowledge bases · ${agent.knowledgeAssetIds.length + agent.templateAssetIds.length} direct resources`,
                    )}
                  </p>
                  <p className="mt-1">
                    {tr(
                      `技能 ${agent.skillIds.length} · 工具 ${agent.toolIds.length}`,
                      `${agent.skillIds.length} skills · ${agent.toolIds.length} tools`,
                    )}
                  </p>
                </td>
                <td>{dateLabel(agent.updatedAt)}</td>
                <td>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setChecking(agent)}
                    >
                      {tr('配置检查', 'Check setup')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!agent.published}
                      onClick={() => trial(agent)}
                    >
                      {tr('试用', 'Try')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => openEditor(agent)}
                    >
                      {tr('编辑', 'Edit')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={resource.busy}
                      onClick={() => setDeleting(agent)}
                    >
                      {tr('删除', 'Delete')}
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {!resource.loading && resource.data?.items.length === 0 && (
              <tr>
                <td colSpan={5} className="text-muted-foreground">
                  {tr(
                    '暂无智能体，点击“新增智能体”开始配置。',
                    'No agents. Create an agent to get started.',
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <AgentDefinitionEditor
        open={!!editing}
        editing={editing !== 'new'}
        draft={draft}
        onChange={setDraft}
        onClose={() => setEditing(null)}
        onSave={save}
        catalog={catalog.data}
        loading={catalog.loading}
        catalogError={catalog.error}
        onRetry={catalog.reload}
        busy={resource.busy}
        error={validationError || resource.error}
      />
      <ManagementDialog
        open={!!checking}
        onOpenChange={(open) => !open && setChecking(null)}
        title={tr('智能体配置检查', 'Agent setup check')}
        description={tr(
          '检查已保存的配置。检查通过不代表模型、资料内容或真实任务已验收；工作台中的现有会话保留原版本。',
          'Checks saved configuration. A pass does not verify the model, source content or a real task. Existing workspace sessions retain their version.',
        )}
        error={readiness.error}
        footer={
          <Button variant="outline" onClick={() => setChecking(null)}>
            {tr('关闭', 'Close')}
          </Button>
        }
      >
        <ResourceState
          loading={readiness.loading}
          error={readiness.error}
          onRetry={readiness.reload}
        />
        <ul className="space-y-3 text-sm">
          {readiness.data?.checks.map((check) => (
            <li key={check.id} className="rounded-lg border p-3">
              <span
                className={
                  check.status === 'error'
                    ? 'text-destructive'
                    : 'text-muted-foreground'
                }
              >
                {check.status === 'pass' ? '✓ ' : '· '}
                {check.message}
              </span>
            </li>
          ))}
        </ul>
      </ManagementDialog>
      <ManagementDialog
        open={copyingExamples}
        onOpenChange={setCopyingExamples}
        title={tr('复制新版办公示例', 'Copy updated office examples')}
        busy={resource.busy}
        error={resource.error}
        description={tr(
          '创建 Excel、PPT、企业知识助手的新版草稿和独立技能；保留你的已有配置，不恢复已经删除的原始示例。每个版本只复制一次。',
          'Create updated Excel, PPT and knowledge drafts with separate skills. Existing configurations remain unchanged, and deleted originals stay deleted. Each version is copied once.',
        )}
        footer={
          <>
            <Button
              variant="outline"
              disabled={resource.busy}
              onClick={() => setCopyingExamples(false)}
            >
              {tr('取消', 'Cancel')}
            </Button>
            <Button
              disabled={resource.busy}
              onClick={async () => {
                if (await resource.perform(() => agentsApi.seedDemo(true))) {
                  setCopyingExamples(false)
                  catalog.reload()
                }
              }}
            >
              {tr('复制为草稿', 'Copy as drafts')}
            </Button>
          </>
        }
      />
      <ManagementDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={tr('删除智能体', 'Delete agent')}
        busy={resource.busy}
        error={resource.error}
        description={tr(
          `确认删除「${deleting?.name ?? ''}」？删除后不能用于新会话。`,
          `Delete ${deleting?.name ?? ''}? It will no longer be available for new sessions.`,
        )}
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
                  (await resource.perform(() => agentsApi.remove(deleting.id)))
                )
                  setDeleting(null)
              }}
            >
              {tr('删除', 'Delete')}
            </Button>
          </>
        }
      />
    </ManagementList>
  )
}
