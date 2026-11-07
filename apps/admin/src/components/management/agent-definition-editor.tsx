'use client'

import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { AgentCatalog, AgentDefinitionWrite } from '@/features/agents/api'
import { FieldLabel, ResourceState, useManagementText } from './controls'
import { ManagementDialog } from './presentation'

export function AgentDefinitionEditor({
  open,
  editing,
  draft,
  onChange,
  onClose,
  onSave,
  catalog,
  loading,
  catalogError,
  onRetry,
  busy,
  error,
}: {
  open: boolean
  editing: boolean
  draft: AgentDefinitionWrite
  onChange: (draft: AgentDefinitionWrite) => void
  onClose: () => void
  onSave: (event: React.FormEvent) => void
  catalog: AgentCatalog | null
  loading: boolean
  catalogError: string
  onRetry: () => void
  busy: boolean
  error: string
}) {
  const tr = useManagementText()
  const formId = React.useId()
  const groups = [
    {
      key: 'knowledgeBaseIds' as const,
      title: tr('关联知识库', 'Knowledge bases'),
      items: catalog?.knowledgeBases ?? [],
    },
    {
      key: 'knowledgeAssetIds' as const,
      title: tr('参考知识', 'Reference knowledge'),
      items: (catalog?.assets ?? [])
        .filter(
          (asset) =>
            asset.kind === 'knowledge' &&
            draft.knowledgeAssetIds.includes(asset.id),
        )
        .map((asset) => ({ ...asset, description: asset.preview })),
    },
    {
      key: 'templateAssetIds' as const,
      title: tr('输出模板', 'Output templates'),
      items: (catalog?.assets ?? [])
        .filter(
          (asset) =>
            asset.kind !== 'knowledge' &&
            draft.templateAssetIds.includes(asset.id),
        )
        .map((asset) => ({ ...asset, description: '' })),
    },
    {
      key: 'skillIds' as const,
      title: tr('业务技能', 'Skills'),
      items: catalog?.skills ?? [],
    },
    {
      key: 'toolIds' as const,
      title: tr('可用工具', 'Tools'),
      items: catalog?.tools ?? [],
    },
  ].filter(
    (group) =>
      !['knowledgeAssetIds', 'templateAssetIds'].includes(group.key) ||
      group.items.length,
  )
  return (
    <ManagementDialog
      open={open}
      onOpenChange={(value) => !value && onClose()}
      title={
        editing
          ? tr('编辑智能体', 'Edit agent')
          : tr('新增智能体', 'Create agent')
      }
      description={tr(
        '知识库、技能和工具分别在对应菜单管理，这里只选择关联。模型沿用工作台会话中选择的模型。',
        'Manage knowledge bases, skills and tools from their own menus, then link them here. The model is selected in the workspace.',
      )}
      busy={busy}
      error={error}
      className="sm:max-w-3xl"
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={onClose}
          >
            {tr('取消', 'Cancel')}
          </Button>
          <Button
            type="submit"
            form={formId}
            disabled={busy || loading || !!catalogError || !catalog}
          >
            {busy ? tr('保存中…', 'Saving…') : tr('保存', 'Save')}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSave} className="space-y-5">
        <fieldset disabled={busy} className="space-y-4">
          <FieldLabel title="技能选择策略">
            <select
              aria-label="技能选择策略"
              className="h-9 w-full rounded border bg-background px-2"
              value={draft.skillPolicy?.mode ?? 'legacy'}
              onChange={(e) =>
                onChange({
                  ...draft,
                  skillPolicy: {
                    mode: e.target.value as 'legacy' | 'auto' | 'fixed',
                    ...(e.target.value === 'fixed'
                      ? {
                          fixedSkillId:
                            draft.skillIds.find((id) =>
                              catalog?.skills.some(
                                (skill) => skill.id === id && skill.program,
                              ),
                            ) ?? '',
                        }
                      : {}),
                  },
                })
              }
            >
              <option value="legacy">原有方法指令（兼容已有技能）</option>
              <option value="auto">自动匹配已关联的阶段技能</option>
              <option value="fixed">固定执行一个阶段技能</option>
            </select>
          </FieldLabel>
          {draft.skillPolicy?.mode === 'fixed' && (
            <FieldLabel title="固定技能">
              <select
                className="h-9 w-full rounded border bg-background px-2"
                value={draft.skillPolicy.fixedSkillId ?? ''}
                onChange={(e) =>
                  onChange({
                    ...draft,
                    skillPolicy: {
                      mode: 'fixed',
                      fixedSkillId: e.target.value,
                    },
                  })
                }
              >
                <option value="">请选择已发布的技能</option>
                {catalog?.skills
                  .filter(
                    (skill) =>
                      draft.skillIds.includes(skill.id) && skill.program,
                  )
                  .map((skill) => (
                    <option key={skill.id} value={skill.id}>
                      {skill.name}
                    </option>
                  ))}
              </select>
            </FieldLabel>
          )}
          <FieldLabel title={tr('名称', 'Name')}>
            <Input
              required
              maxLength={80}
              value={draft.name}
              onChange={(e) => onChange({ ...draft, name: e.target.value })}
              placeholder={tr(
                '例如：企业资料问答助手',
                'For example: Company knowledge assistant',
              )}
            />
          </FieldLabel>
          <FieldLabel title={tr('用途说明', 'Purpose')}>
            <Textarea
              required
              maxLength={500}
              value={draft.description}
              onChange={(e) =>
                onChange({ ...draft, description: e.target.value })
              }
              placeholder={tr(
                '说明帮助谁、解决什么问题，以及输出什么结果。',
                'Who does this help, what problem does it solve, and what does it produce?',
              )}
            />
          </FieldLabel>
          <FieldLabel title={tr('工作要求', 'Instructions')}>
            <Textarea
              required
              rows={5}
              maxLength={6000}
              value={draft.instructions}
              onChange={(e) =>
                onChange({ ...draft, instructions: e.target.value })
              }
              placeholder={tr(
                '用自然语言描述步骤、输出格式，以及资料不足时如何处理。',
                'Describe the steps, expected output and how to handle missing information.',
              )}
            />
          </FieldLabel>
          <ResourceState
            loading={loading}
            error={catalogError}
            onRetry={onRetry}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            {(
              [
                [
                  'recommendedPrompts',
                  tr(
                    '推荐指令（每行一条）',
                    'Suggested prompts (one per line)',
                  ),
                  tr(
                    '例如：清理上传的费用表，按部门汇总并制作图表。',
                    'For example: clean uploaded expense data and summarize it by department.',
                  ),
                ],
                [
                  'inputRequirements',
                  tr(
                    '输入要求（每行一条）',
                    'Input requirements (one per line)',
                  ),
                  tr(
                    '文件格式、必要字段、适用范围及限制。',
                    'File types, required fields, applicable scope and limits.',
                  ),
                ],
                [
                  'outputExamples',
                  tr('输出示例（每行一条）', 'Output examples (one per line)'),
                  tr(
                    '例如：费用清洗.xlsx，含汇总、异常记录和可编辑图表。',
                    'For example: Expenses.xlsx with summaries, anomalies and editable charts.',
                  ),
                ],
              ] as const
            ).map(([key, title, placeholder]) => (
              <FieldLabel key={key} title={title}>
                <Textarea
                  rows={3}
                  maxLength={4000}
                  value={(draft[key] ?? []).join('\n')}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      [key]: event.target.value.split('\n'),
                    })
                  }
                  placeholder={placeholder}
                />
              </FieldLabel>
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {groups.map(({ key, title, items }) => (
              <fieldset
                key={key}
                className="min-w-0 rounded-xl border p-3"
                disabled={loading || !!catalogError}
              >
                <legend className="px-1 text-sm font-medium">{title}</legend>
                <div className="max-h-48 space-y-2 overflow-y-auto">
                  {!items.length && (
                    <p className="text-xs text-muted-foreground">
                      {tr(
                        '暂无可选项，请先在对应管理菜单中配置。',
                        'No available items. Configure resources from their management menu first.',
                      )}
                    </p>
                  )}
                  {items.map((item) => (
                    <label
                      key={item.id}
                      className="flex cursor-pointer items-start gap-2 rounded-lg p-2 hover:bg-muted/50"
                    >
                      <input
                        type="checkbox"
                        className="mt-1 accent-primary"
                        checked={draft[key].includes(item.id)}
                        disabled={
                          'enabled' in item &&
                          !item.enabled &&
                          !draft[key].includes(item.id)
                        }
                        onChange={(event) => {
                          const next = {
                            ...draft,
                            [key]: event.target.checked
                              ? [...draft[key], item.id]
                              : draft[key].filter((id) => id !== item.id),
                          }
                          if (key === 'skillIds' && event.target.checked) {
                            const skill = catalog?.skills.find(
                              (entry) => entry.id === item.id,
                            )
                            next.toolIds = [
                              ...new Set([
                                ...next.toolIds,
                                ...(skill?.requiredToolIds ?? []),
                              ]),
                            ]
                          }
                          onChange(next)
                        }}
                      />
                      <span className="min-w-0 text-sm">
                        <span className="block font-medium">
                          {item.name}
                          {'enabled' in item && !item.enabled
                            ? tr('（已停用）', ' (disabled)')
                            : ''}
                        </span>
                        {item.description && (
                          <span className="mt-1 block line-clamp-2 text-xs text-muted-foreground">
                            {item.description}
                          </span>
                        )}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
          <p className="rounded-xl bg-muted/40 p-3 text-xs text-muted-foreground">
            {tr(
              '保存时检查资料归属、技能依赖和工具状态。模板可选；没有知识资料时无法给出公司依据。配置修改用于新会话，已有会话保留原版本；发布后请从“试用”验证真实任务。',
              'Saving checks ownership, skill dependencies and tool status. Templates are optional; company answers need knowledge sources. Changes apply to new sessions. Existing sessions retain their version; use Try after publication to verify a real task.',
            )}
          </p>
          <label className="flex items-start gap-3 rounded-xl border p-3 text-sm">
            <input
              type="checkbox"
              className="mt-1 accent-primary"
              checked={draft.published}
              onChange={(e) =>
                onChange({ ...draft, published: e.target.checked })
              }
            />
            <span>
              <span className="font-medium">
                {tr('发布到工作台', 'Publish to workspace')}
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {tr(
                  '发布后，当前平台具备会话执行权限的用户可以使用；未发布的草稿仅用于管理。',
                  'Published agents are available to users with session execution permission on this platform. Drafts remain in management.',
                )}
              </span>
            </span>
          </label>
        </fieldset>
      </form>
    </ManagementDialog>
  )
}
