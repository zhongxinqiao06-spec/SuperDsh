'use client'

import * as React from 'react'
import type {
  SkillProgram,
  SkillStageDefinition,
} from '@superdsh/core/contracts/skills'
import { documentSkillProgram } from '@superdsh/core/client/skill-presets'
import type { AgentSkill, AgentTool } from '@/features/agents/resources-api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { FieldLabel } from './controls'

export function SkillProgramEditor({
  value,
  onChange,
  tools,
  skills,
}: {
  value?: SkillProgram | null
  onChange(value: SkillProgram | null): void
  tools: AgentTool[]
  skills: AgentSkill[]
}) {
  const set = (change: Partial<SkillProgram>) =>
    value && onChange({ ...value, ...change })
  const updateStage = (index: number, change: Partial<SkillStageDefinition>) =>
    value &&
    set({
      stages: value.stages.map((stage, i) =>
        i === index ? { ...stage, ...change } : stage,
      ),
    })
  return (
    <fieldset className="space-y-3 rounded-xl border p-4">
      <legend className="px-1 font-medium">自动匹配与阶段配置</legend>
      <p className="text-xs text-muted-foreground">
        保存为草稿后发布。已有会话保留原版本。引用单项技能可以复用方法，工具授权和确认由服务端检查。
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => onChange(documentSkillProgram('ppt'))}
        >
          使用 PPT 流程起点
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => onChange(documentSkillProgram('word'))}
        >
          使用 Word 流程起点
        </Button>
        {value && (
          <Button
            type="button"
            variant="outline"
            onClick={() => onChange(null)}
          >
            撤销阶段草稿
          </Button>
        )}
      </div>
      {value && (
        <>
          {(
            [
              'phrases',
              'excludePhrases',
              'inputExtensions',
              'outputTypes',
              'examples',
            ] as const
          ).map((key) => (
            <FieldLabel
              key={key}
              title={
                {
                  phrases: '匹配词（每行一项）',
                  excludePhrases: '排除词',
                  inputExtensions: '输入扩展名（空表示不限）',
                  outputTypes: '输出类型',
                  examples: '适用请求示例',
                }[key]
              }
            >
              <Textarea
                value={value.match[key].join('\n')}
                rows={2}
                onChange={(e) =>
                  set({
                    match: {
                      ...value.match,
                      [key]: e.target.value.split('\n'),
                    },
                  })
                }
              />
            </FieldLabel>
          ))}
          <div className="flex gap-3">
            <FieldLabel title="最大修订次数">
              <Input
                type="number"
                min={0}
                max={5}
                value={value.maxRevisions}
                onChange={(e) => set({ maxRevisions: Number(e.target.value) })}
              />
            </FieldLabel>
            <FieldLabel title="单次工具执行时限（秒）">
              <Input
                type="number"
                min={30}
                max={3600}
                value={value.timeoutSeconds}
                onChange={(e) =>
                  set({ timeoutSeconds: Number(e.target.value) })
                }
              />
            </FieldLabel>
          </div>
          {value.stages.map((stage, index) => (
            <details key={index} className="rounded-lg border p-3" open>
              <summary className="cursor-pointer font-medium">
                {index + 1}. {stage.name}
              </summary>
              <div className="mt-3 space-y-3">
                <div className="flex gap-2">
                  <FieldLabel title="阶段标识">
                    <Input
                      value={stage.id}
                      onChange={(e) =>
                        updateStage(index, { id: e.target.value })
                      }
                    />
                  </FieldLabel>
                  <FieldLabel title="阶段名称">
                    <Input
                      value={stage.name}
                      onChange={(e) =>
                        updateStage(index, { name: e.target.value })
                      }
                    />
                  </FieldLabel>
                </div>
                <FieldLabel title="完成方式">
                  <select
                    className="h-9 w-full rounded border bg-background px-2"
                    value={stage.operation}
                    onChange={(e) =>
                      updateStage(index, {
                        operation: e.target
                          .value as SkillStageDefinition['operation'],
                      })
                    }
                  >
                    {Object.entries({
                      submit: '模型提交结构化结果',
                      inspect: '真实工具检查输入',
                      prepare: '真实工具预检方案',
                      execute: '用户确认后生成',
                      review: '核验已保存成果',
                    }).map(([id, label]) => (
                      <option key={id} value={id}>
                        {label}
                      </option>
                    ))}
                  </select>
                </FieldLabel>
                <FieldLabel title="引用已有单项技能">
                  <select
                    className="h-9 w-full rounded border bg-background px-2"
                    value={stage.skillId ?? ''}
                    onChange={(e) =>
                      updateStage(index, {
                        skillId: e.target.value || undefined,
                      })
                    }
                  >
                    <option value="">只使用本阶段指令</option>
                    {skills
                      .filter((skill) => !skill.program && !skill.programDraft)
                      .map((skill) => (
                        <option key={skill.id} value={skill.id}>
                          {skill.name}
                        </option>
                      ))}
                  </select>
                </FieldLabel>
                <FieldLabel title="阶段指令">
                  <Textarea
                    rows={3}
                    value={stage.instructions}
                    onChange={(e) =>
                      updateStage(index, { instructions: e.target.value })
                    }
                  />
                </FieldLabel>
                <fieldset>
                  <legend className="text-sm">允许工具</legend>
                  {tools.map((tool) => (
                    <label
                      key={tool.id}
                      className="mr-3 inline-flex items-center gap-1 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={stage.toolIds.includes(tool.id)}
                        onChange={(e) =>
                          updateStage(index, {
                            toolIds: e.target.checked
                              ? [...stage.toolIds, tool.id]
                              : stage.toolIds.filter((id) => id !== tool.id),
                          })
                        }
                      />
                      {tool.name}
                    </label>
                  ))}
                </fieldset>
                <fieldset>
                  <legend className="text-sm">校验依据</legend>
                  {(
                    [
                      'schema',
                      'sources',
                      'plan',
                      'artifact',
                      'rendered-quality',
                    ] as const
                  ).map((check) => (
                    <label
                      key={check}
                      className="mr-3 inline-flex items-center gap-1 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={stage.checks.includes(check)}
                        onChange={(e) =>
                          updateStage(index, {
                            checks: e.target.checked
                              ? [...stage.checks, check]
                              : stage.checks.filter((id) => id !== check),
                          })
                        }
                      />
                      {
                        {
                          schema: '输出结构',
                          sources: '真实输入资料',
                          plan: '预检方案',
                          artifact: '已保存文件',
                          'rendered-quality': '最终渲染',
                        }[check]
                      }
                    </label>
                  ))}
                </fieldset>
                <SchemaEditor
                  value={stage.outputSchema}
                  onChange={(outputSchema) =>
                    updateStage(index, { outputSchema })
                  }
                />
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={index === 0}
                    onClick={() => {
                      const stages = [...value.stages]
                      ;[stages[index - 1], stages[index]] = [
                        stages[index]!,
                        stages[index - 1]!,
                      ]
                      set({ stages })
                    }}
                  >
                    上移
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      set({
                        stages: value.stages.filter((_, i) => i !== index),
                      })
                    }
                  >
                    移除阶段
                  </Button>
                </div>
              </div>
            </details>
          ))}
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              set({
                stages: [
                  ...value.stages,
                  {
                    id: `stage${value.stages.length + 1}`,
                    name: '新阶段',
                    operation: 'submit',
                    instructions: '请填写阶段要求',
                    toolIds: [],
                    checks: ['schema'],
                    outputSchema: {
                      type: 'object',
                      properties: {
                        summary: { type: 'string', minLength: 10 },
                      },
                      required: ['summary'],
                    },
                  },
                ],
              })
            }
          >
            添加阶段
          </Button>
        </>
      )}
    </fieldset>
  )
}

function SchemaEditor({
  value,
  onChange,
}: {
  value: Record<string, unknown>
  onChange(value: Record<string, unknown>): void
}) {
  const [draft, setDraft] = React.useState(JSON.stringify(value, null, 2))
  const [error, setError] = React.useState('')
  React.useEffect(() => setDraft(JSON.stringify(value, null, 2)), [value])
  return (
    <FieldLabel title="输出 JSON Schema">
      <Textarea
        value={draft}
        rows={4}
        onChange={(e) => {
          setDraft(e.target.value)
          try {
            const parsed: unknown = JSON.parse(e.target.value)
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
              throw new Error()
            onChange(parsed as Record<string, unknown>)
            setError('')
            e.target.setCustomValidity('')
          } catch {
            setError('请输入有效 JSON 对象')
            e.target.setCustomValidity('请输入有效 JSON 对象')
          }
        }}
        aria-invalid={!!error}
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </FieldLabel>
  )
}
