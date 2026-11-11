import type { AgentDraft } from '@/types/agents/agents'

/** 编辑器分区键不写入业务数据；校验映射保证隐藏分区的错误可被定位。 */
export type AgentEditorSection = 'basic' | 'behavior' | 'resources' | 'examples'
export type AgentRequiredField = 'name' | 'description' | 'instructions'

export interface AgentFieldIssue {
  field: AgentRequiredField
  section: AgentEditorSection
  message: string
}

/** 与原有保存必填边界一致，返回首个问题用于切换分区和聚焦。 */
export function agentFieldIssue(
  draft: AgentDraft,
): AgentFieldIssue | undefined {
  if (!draft.name.trim())
    return { field: 'name', section: 'basic', message: '请填写智能体名称' }
  if (!draft.description.trim())
    return { field: 'description', section: 'basic', message: '请填写用途说明' }
  if (!draft.instructions.trim())
    return {
      field: 'instructions',
      section: 'behavior',
      message: '请填写工作要求',
    }
  return undefined
}
