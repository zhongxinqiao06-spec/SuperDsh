'use client'

import { useEffect } from 'react'
import { agentsApi } from '@/features/agents/api'
import { MarkdownText } from '@/components/markdown-text'
import {
  ResourceState,
  useManagementResource,
  useManagementText,
} from '@/components/management/controls'
import { Button } from '@/components/ui/button'

export function AgentSessionOfficeContext({
  sessionId,
  status,
}: {
  sessionId: string
  status: string
}) {
  const tr = useManagementText()
  const resource = useManagementResource(
    `office-context:${sessionId}:${status}`,
    async () => {
      const [plans, evidence] = await Promise.all([
        agentsApi.officePlans(sessionId),
        agentsApi.evidence(sessionId),
      ])
      return {
        plans: plans.items,
        evidence: evidence.items,
        answerVerification: evidence.answerVerification,
      }
    },
  )
  const states = {
    prepared: tr('等待方案确认', 'Awaiting confirmation'),
    running: tr('正在生成', 'Generating'),
    completed: tr('已生成', 'Completed'),
    failed: tr('生成失败', 'Failed'),
    cancelled: tr('已取消', 'Cancelled'),
    interrupted: tr('执行已中断', 'Interrupted'),
    'timed-out': tr('执行超时', 'Timed out'),
  }
  useEffect(() => {
    if (
      status !== 'running' &&
      !resource.data?.plans.some((plan) => plan.state === 'running')
    )
      return
    const timer = setInterval(resource.reload, 3000)
    return () => clearInterval(timer)
  }, [status, resource.data, resource.reload])
  return (
    <div className="mt-3 space-y-3">
      <ResourceState
        loading={false}
        error={resource.error}
        onRetry={resource.reload}
      />
      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          disabled={resource.loading}
          onClick={resource.reload}
        >
          {tr('刷新方案与依据', 'Refresh plans and evidence')}
        </Button>
      </div>
      {resource.data?.plans.map((plan) => (
        <details className="rounded-lg border p-3 text-sm" key={plan.id}>
          <summary className="cursor-pointer font-medium">
            {plan.title} · v{plan.version} ·{' '}
            {plan.state === 'running' && plan.stage === 'rendering'
              ? tr('正在渲染最终文件', 'Rendering final document')
              : states[plan.state]}
          </summary>
          <div className="mt-3 space-y-2">
            <MarkdownText text={plan.summary} />
            <details>
              <summary className="cursor-pointer">
                {tr('完整方案数据', 'Complete plan data')}
              </summary>
              <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">
                {JSON.stringify(plan.document, null, 2)}
              </pre>
            </details>
            {!!plan.sources?.length && (
              <ul className="text-xs text-muted-foreground">
                {plan.sources.map((source) => (
                  <li key={source.id}>
                    {source.name} · {source.sha256.slice(0, 12)}
                  </li>
                ))}
              </ul>
            )}
            {plan.warnings?.map((warning) => (
              <p className="text-amber-600 dark:text-amber-400" key={warning}>
                {warning}
              </p>
            ))}
            {plan.error && (
              <p role="alert" className="text-destructive">
                {plan.error}
              </p>
            )}
            {plan.state === 'prepared' && (
              <p className="text-xs text-muted-foreground">
                {tr(
                  '请在聊天中的方案确认卡选择；如需修改，直接回复修改要求。',
                  'Use the confirmation card in chat. Reply with changes to revise the plan.',
                )}
              </p>
            )}
          </div>
        </details>
      ))}
      {!!resource.data?.evidence.length && (
        <section aria-label={tr('回答依据', 'Answer evidence')}>
          <h4 className="mb-2 text-sm font-medium">
            {tr('检索原文', 'Retrieved source excerpts')}
          </h4>
          <div className="space-y-2">
            {resource.data.evidence.map((source) => (
              <details
                className="rounded-lg border p-3 text-sm"
                key={source.id}
              >
                <summary className="cursor-pointer break-words">
                  {source.filename}{' '}
                  {!Object.keys(source.location ?? {}).length &&
                    tr(
                      '· 旧资料未记录原文位置',
                      '· Legacy source location was not recorded',
                    )}
                  {source.location?.page
                    ? `· ${tr('页', 'Page')} ${source.location.page}`
                    : ''}
                  {source.location?.sheet ? ` · ${source.location.sheet}` : ''}
                  {source.location?.row
                    ? ` · ${tr('行', 'Row')} ${source.location.row}`
                    : ''}
                </summary>
                <div className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap break-words text-muted-foreground">
                  {source.content}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {source.sourceId} · {source.sha256.slice(0, 12)}
                </p>
              </details>
            ))}
          </div>
        </section>
      )}
      {resource.data?.answerVerification && (
        <div
          role={
            resource.data.answerVerification.status === 'invalid'
              ? 'alert'
              : 'status'
          }
          className="rounded-lg border p-3 text-sm"
        >
          <p>{resource.data.answerVerification.message}</p>
          {!!resource.data.answerVerification.issues.length && (
            <ul className="mt-2 list-inside list-disc break-words text-destructive">
              {resource.data.answerVerification.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
