import { documentSkillProgram } from '@superdsh/core/client/skill-presets'

/** Editable catalog seeds. These identifiers never participate in runtime dispatch. */
export const documentFlowSkills = (['ppt', 'word'] as const).map((kind) => {
  const program = documentSkillProgram(kind)
  if (kind === 'ppt') {
    program.stages[1]!.skillId = 'presentation-planning'
    program.stages[2]!.skillId = 'presentation-layout'
    program.stages[5]!.skillId = 'presentation-quality'
  } else program.stages[1]!.skillId = 'business-document'
  return {
    id: kind === 'ppt' ? 'presentation-flow' : 'document-flow',
    name: kind === 'ppt' ? 'PPT 制作与校验流程' : 'Word 编制与校验流程',
    description:
      '按需求匹配，逐阶段检查、策划、排版、确认、生成和校验；保留独立执行记录。',
    instructions:
      '遵循已发布阶段，使用真实工具和授权资料，失败时按记录修订，不虚报成功。',
    program,
  }
})
