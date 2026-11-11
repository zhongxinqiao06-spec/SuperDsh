import type { AgentCatalog, AgentDraft } from '@/types/agents/agents'

/** 资源关系写入草稿副本；选中技能时合并依赖工具，取消技能不移除可能被其他技能使用的工具。 */
export function selectAgentResource(
  draft: AgentDraft,
  key:
    | 'knowledgeBaseIds'
    | 'knowledgeAssetIds'
    | 'templateAssetIds'
    | 'skillIds'
    | 'toolIds',
  ids: string[],
  itemId: string,
  checked: boolean,
  catalog: AgentCatalog | null,
): AgentDraft {
  return {
    ...draft,
    [key]: ids,
    ...(key === 'skillIds' && checked
      ? {
          toolIds: [
            ...new Set([
              ...draft.toolIds,
              ...(catalog?.skills.find((skill) => skill.id === itemId)
                ?.requiredToolIds ?? []),
            ]),
          ],
        }
      : {}),
  }
}

/** 固定策略默认选择已关联的阶段技能，不能从未关联目录中猜选。 */
export function agentSkillPolicy(
  mode: 'legacy' | 'auto' | 'fixed',
  draft: AgentDraft,
  catalog: AgentCatalog | null,
): NonNullable<AgentDraft['skillPolicy']> {
  return {
    mode,
    ...(mode === 'fixed'
      ? {
          fixedSkillId:
            draft.skillIds.find((id) =>
              catalog?.skills.some((skill) => skill.id === id && skill.program),
            ) ?? '',
        }
      : {}),
  }
}
