import { skillStateLabels } from '@superdsh/core/client/skill-run-view'
import { object, rows, string, type Row } from './platform-model.ts'

export function SkillRuns({ items = [] }: { items: Row[] }) {
  return (
    <section aria-label="技能执行记录">
      {items.map((run) => (
        <details key={string(run.id)} open={run.state !== 'completed'}>
          <summary>
            {string(run.skillName)} · {skillStateLabels[string(run.state)]} · v
            {String(run.skillVersion)}
          </summary>
          <p>选择依据：{string(object(run.selection).reason)}</p>
          <ol>
            {rows(run.stages).map((stage) => (
              <li key={string(stage.id)}>
                <details>
                  <summary>
                    {string(stage.name)} ·{' '}
                    {skillStateLabels[string(stage.state)]}
                  </summary>
                  <small>
                    {string(stage.skillId)} v{String(stage.skillVersion)} · 第{' '}
                    {String(stage.attempt)} 次
                  </small>
                  {!!stage.error && <p role="alert">{string(stage.error)}</p>}
                  {rows(stage.checks).map((check, i) => (
                    <p key={i}>
                      {check.passed ? '✓' : '×'} {string(check.message)}
                    </p>
                  ))}
                  {rows(stage.calls).map((call, i) => (
                    <p key={i}>
                      {string(call.tool)} · {string(call.phase)} ·{' '}
                      {skillStateLabels[string(call.state)]}
                    </p>
                  ))}
                  {!!stage.output && (
                    <details>
                      <summary>阶段结果</summary>
                      <pre
                        style={{
                          maxHeight: 240,
                          overflow: 'auto',
                          whiteSpace: 'pre-wrap',
                          overflowWrap: 'anywhere',
                        }}
                      >
                        {JSON.stringify(stage.output, null, 2)}
                      </pre>
                    </details>
                  )}
                </details>
              </li>
            ))}
          </ol>
        </details>
      ))}
    </section>
  )
}
