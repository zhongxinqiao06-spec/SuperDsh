'use client'

import type { SkillRun } from '@superdsh/core/contracts/skills'
import { skillStateLabels } from '@superdsh/core/client/skill-run-view'
import { apiClient } from '@/lib/api'
import {
  useManagementResource,
  ResourceState,
} from '@/components/management/controls'

export function SessionSkillRuns({ sessionId }: { sessionId: string }) {
  const resource = useManagementResource(
    `skill-runs:${sessionId}`,
    () =>
      apiClient.get<{ items: SkillRun[] }>(
        `/sessions/${encodeURIComponent(sessionId)}/skill-runs`,
      ),
    { autoRefreshMs: 5000 },
  )
  return (
    <section aria-label="技能执行记录" className="mt-4 space-y-3">
      <ResourceState
        loading={false}
        error={resource.error}
        onRetry={resource.reload}
      />
      {resource.data?.items.map((run) => (
        <details
          key={run.id}
          className="rounded-lg border p-3"
          open={run.state !== 'completed'}
        >
          <summary className="cursor-pointer text-sm font-medium">
            {run.skillName} · {skillStateLabels[run.state]} · v
            {run.skillVersion}
          </summary>
          <p className="my-2 text-xs text-muted-foreground">
            选择依据：{run.selection.reason} · 修订 {run.revision}
          </p>
          <ol className="space-y-2">
            {run.stages.map((stage, index) => (
              <li key={stage.id} className="rounded border p-2 text-sm">
                <details>
                  <summary className="cursor-pointer">
                    {index + 1}. {stage.name} · {skillStateLabels[stage.state]}
                  </summary>
                  <p className="mt-1 text-xs text-muted-foreground">
                    技能 {stage.skillId} v{stage.skillVersion} · 第{' '}
                    {stage.attempt} 次
                  </p>
                  {stage.error && (
                    <p role="alert" className="text-destructive">
                      {stage.error}
                    </p>
                  )}
                  {stage.checks.map((check, i) => (
                    <p
                      key={i}
                      className={
                        check.passed
                          ? 'text-muted-foreground'
                          : 'text-destructive'
                      }
                    >
                      {check.passed ? '✓' : '×'} {check.message}
                    </p>
                  ))}
                  {stage.calls.map((call, i) => (
                    <p key={i} className="text-xs">
                      {call.tool} · {call.phase} ·{' '}
                      {skillStateLabels[call.state] ?? call.state}
                      {call.planId ? ` · 方案 ${call.planId}` : ''}
                    </p>
                  ))}
                  {stage.output && (
                    <details>
                      <summary>阶段结果</summary>
                      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">
                        {JSON.stringify(stage.output, null, 2)}
                      </pre>
                    </details>
                  )}
                </details>
              </li>
            ))}
          </ol>
          {!!run.history.length && (
            <p className="mt-2 text-xs text-muted-foreground">
              保留 {run.history.length} 条旧阶段记录，旧成果未覆盖。
            </p>
          )}
        </details>
      ))}
    </section>
  )
}
