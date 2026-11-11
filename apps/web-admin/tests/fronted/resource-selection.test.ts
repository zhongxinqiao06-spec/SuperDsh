import { describe, expect, it } from 'vitest'
import { agentDraft } from '@/utils/agents/agent-drafts'
import {
  agentSkillPolicy,
  selectAgentResource,
} from '@/utils/agents/resource-selection'
import type { AgentCatalog, AgentDefinition } from '@/types/agents/agents'

const catalog: AgentCatalog = {
  assets: [],
  knowledgeBases: [],
  tools: [],
  skills: [
    {
      id: 'skill',
      name: '阶段技能',
      enabled: true,
      description: '',
      version: 1,
      program: {},
      requiredToolIds: ['existing', 'required'],
    },
  ],
}

describe('旧智能体关联选择语义', () => {
  it('预置示例省略空资源列表时仍可编辑并提交完整数组，保留资源修订', () => {
    const source: AgentDefinition = {
      id: 'example-agent',
      name: '预置智能体',
      description: '合成示例',
      instructions: '仅使用用户配置',
      skillIds: ['configured-skill'],
      published: true,
      version: 7,
      createdAt: '2026-11-09T00:00:00Z',
      updatedAt: '2026-11-09T00:00:00Z',
    }
    const draft = agentDraft(source)
    expect(draft).toEqual({
      name: source.name,
      description: source.description,
      instructions: source.instructions,
      published: true,
      version: 7,
      recommendedPrompts: [],
      inputRequirements: [],
      outputExamples: [],
      knowledgeBaseIds: [],
      knowledgeAssetIds: [],
      templateAssetIds: [],
      skillIds: ['configured-skill'],
      toolIds: [],
    })
    draft.skillIds.push('new-skill')
    expect(source.skillIds).toEqual(['configured-skill'])
    expect(source).not.toHaveProperty('knowledgeAssetIds')
  })
  it('选择技能合并工具依赖且不污染原草稿，解除关联保留其他用途的工具', () => {
    const draft = agentDraft()
    draft.toolIds = ['existing']
    const chosen = selectAgentResource(
      draft,
      'skillIds',
      ['skill'],
      'skill',
      true,
      catalog,
    )
    expect(chosen.toolIds).toEqual(['existing', 'required'])
    expect(draft.skillIds).toEqual([])
    expect(draft.toolIds).toEqual(['existing'])
    expect(
      selectAgentResource(chosen, 'skillIds', [], 'skill', false, catalog)
        .toolIds,
    ).toEqual(['existing', 'required'])
  })
  it('固定技能只从已关联阶段技能选取，换策略不残留固定ID', () => {
    const draft = agentDraft()
    expect(agentSkillPolicy('fixed', draft, catalog)).toEqual({
      mode: 'fixed',
      fixedSkillId: '',
    })
    draft.skillIds = ['unknown', 'skill']
    expect(agentSkillPolicy('fixed', draft, catalog)).toEqual({
      mode: 'fixed',
      fixedSkillId: 'skill',
    })
    expect(agentSkillPolicy('auto', draft, catalog)).toEqual({ mode: 'auto' })
  })
})
