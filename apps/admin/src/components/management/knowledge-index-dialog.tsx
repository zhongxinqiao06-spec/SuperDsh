'use client'

import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  knowledgeApi,
  type KnowledgeSource,
} from '@/features/agents/knowledge-api'
import { sessionIdentityRevision } from '@/features/auth/session'
import {
  ResourceState,
  tableClass,
  useManagementResource,
  useManagementText,
} from './controls'
import {
  ManagementDialog,
  ManagementPagination,
  useClientPagination,
} from './presentation'

export function KnowledgeIndexDialog({
  id,
  name,
  onClose,
}: {
  id: string
  name: string
  onClose: () => void
}) {
  const tr = useManagementText()
  const resource = useManagementResource(`knowledge-documents:${id}`, () =>
    knowledgeApi.documents(id),
  )
  const [query, setQuery] = React.useState('')
  const [sources, setSources] = React.useState<KnowledgeSource[] | null>(null)
  const mounted = React.useRef(true)
  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const pagination = useClientPagination(resource.data?.items ?? [], id)
  const labels = {
    pending: tr('待索引', 'Pending'),
    indexing: tr('索引中', 'Indexing'),
    ready: tr('已就绪', 'Ready'),
    failed: tr('失败', 'Failed'),
  }
  const search = async (event: React.FormEvent) => {
    event.preventDefault()
    const identity = sessionIdentityRevision()
    await resource.perform(async () => {
      const result = await knowledgeApi.search(id, query.trim())
      if (mounted.current && identity === sessionIdentityRevision())
        setSources(result.sources)
    })
  }
  return (
    <ManagementDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={tr(`${name} · 索引与检索`, `${name} · indexing and search`)}
      description={tr(
        '查看每份资料状态、重试失败索引，并验证问题实际检索到的原文。',
        'Inspect each document, retry indexing, and verify original evidence retrieved for a question.',
      )}
      busy={resource.busy}
      error={resource.error}
      className="sm:max-w-4xl"
      footer={
        <Button variant="outline" onClick={onClose} disabled={resource.busy}>
          {tr('关闭', 'Close')}
        </Button>
      }
    >
      <ResourceState
        loading={resource.loading}
        error=""
        onRetry={resource.reload}
      />
      <div className="overflow-x-auto rounded-lg border">
        <table className={tableClass}>
          <thead>
            <tr>
              <th>{tr('资料', 'Document')}</th>
              <th>{tr('状态', 'State')}</th>
              <th>{tr('内容片段', 'Passages')}</th>
              <th>{tr('操作', 'Actions')}</th>
            </tr>
          </thead>
          <tbody>
            {pagination.items.map((document) => (
              <tr key={document.assetId}>
                <td>{document.filename}</td>
                <td>
                  {labels[document.state]}
                  {document.message && (
                    <p className="mt-1 text-xs text-destructive">
                      {document.message}
                    </p>
                  )}
                </td>
                <td>{document.chunks}</td>
                <td>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={resource.busy}
                    onClick={() =>
                      void resource.perform(() =>
                        knowledgeApi.retry(id, document.assetId),
                      )
                    }
                  >
                    {tr('重新索引', 'Reindex')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ManagementPagination
        page={pagination.page}
        pageSize={pagination.pageSize}
        total={pagination.total}
        onPageChange={pagination.setPage}
        onPageSizeChange={pagination.setPageSize}
        loading={resource.loading}
      />
      <form className="flex gap-2" onSubmit={search}>
        <Input
          aria-label={tr('检索测试问题', 'Search test question')}
          placeholder={tr(
            '输入问题，检查依据',
            'Ask a question to inspect evidence',
          )}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          maxLength={200}
        />
        <Button type="submit" disabled={resource.busy || !query.trim()}>
          {tr('检索测试', 'Test search')}
        </Button>
      </form>
      {sources?.length === 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          {tr(
            '没有检索到足够依据，请调整问题或补充资料。',
            'No sufficient evidence was found. Refine the question or add resources.',
          )}
        </p>
      )}
      {sources?.map((source) => (
        <article
          key={source.sourceId}
          className="space-y-2 rounded-lg border p-3"
        >
          <p className="text-sm font-medium">
            {source.filename} ·{' '}
            {!Object.keys(source.location).length &&
              tr(
                '旧资料未记录原文位置',
                'Legacy source location was not recorded',
              )}
            {Object.entries(source.location)
              .map(
                ([key, value]) =>
                  `${({ heading: tr('标题', 'Heading'), page: tr('页', 'Page'), sheet: tr('工作表', 'Sheet'), row: tr('行', 'Row'), paragraph: tr('段落', 'Paragraph'), line: tr('行', 'Line') } as Record<string, string>)[key] ?? key} ${value}`,
              )
              .join(' · ')}
          </p>
          <blockquote className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
            {source.content}
          </blockquote>
        </article>
      ))}
    </ManagementDialog>
  )
}
