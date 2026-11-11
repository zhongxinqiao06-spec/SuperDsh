import type { SkillProgram, SkillStageDefinition } from '../contracts/skills.js'

/** Explicit configuration edit, preserving the existing stages and instructions. */
export function withMultimodalTools(program: SkillProgram): SkillProgram {
  const submissions = program.stages.filter(
    (stage) => stage.operation === 'submit',
  )
  const last = submissions.at(-1)?.id
  const inspections = program.stages
    .filter((stage) => stage.operation === 'inspect')
    .flatMap((stage) => stage.toolIds)
  return {
    ...program,
    stages: program.stages.map((stage) => {
      if (stage.operation !== 'submit') return stage
      const guidance =
        '按需调用已授权的辅助工具：vision_analyze 理解参考图片；illustration_render 用 JSON 制作流程等可靠配图；image_generate 使用已绑定模型生图或编辑参考图。每次 plan 仍需用户确认，失败不得自动换模型或改为无图。配图完成后，用 artifactId 以 role:image 传给文档工具 inspect 获取 imageId，再写入最终文档方案；不把正文和精确数字交给生图模型。辅助调用不推进阶段，处理完后再提交 summary；没有配图需求可直接提交。用户拒绝辅助方案时 revise 当前阶段，不能复用旧确认。'
      return {
        ...stage,
        toolIds: [
          ...new Set([
            ...stage.toolIds,
            ...(stage.id === last
              ? ['illustration_render', 'image_generate', 'vision_analyze']
              : ['vision_analyze']),
          ]),
        ],
        inspectToolIds: [
          ...new Set([...(stage.inspectToolIds ?? []), ...inspections]),
        ],
        instructions: stage.instructions.includes(guidance)
          ? stage.instructions
          : `${stage.instructions}\n${guidance}`,
      }
    }),
  }
}

/** Optional editable starting points; runtime dispatch never branches on these names. */
export function documentSkillProgram(kind: 'ppt' | 'word'): SkillProgram {
  const tool = kind === 'ppt' ? 'presentation_report' : 'document_report'
  const schema = { type: 'object', properties: {}, additionalProperties: true }
  const summary = {
    type: 'object',
    properties: {
      summary: { type: 'string', minLength: 20, maxLength: 12000 },
    },
    required: ['summary'],
    additionalProperties: false,
  }
  const stages: SkillStageDefinition[] = [
    {
      id: 'inspect',
      name: '资料检查',
      operation: 'inspect',
      instructions:
        '调用指定工具 action=inspect，检查用户选择的资料和模板。没有资料时 inputsJson=[]，根据用户需求创建，不自动采用演示数据。',
      toolIds: [tool],
      outputSchema: schema,
      checks: ['schema', 'sources'],
    },
    {
      id: 'planning',
      name: '内容策划',
      operation: 'submit',
      instructions:
        kind === 'ppt'
          ? '提交 summary：明确受众、目的、总页数、每页标题及内容、来源和配图用途。不要编造业绩数据。'
          : '提交 summary：明确读者、文档用途、章节层次、每节要点、引用来源和图片用途。不得编造事实。',
      toolIds: [],
      outputSchema: summary,
      checks: ['schema'],
    },
    {
      id: 'layout',
      name: '排版设计',
      operation: 'submit',
      instructions:
        kind === 'ppt'
          ? '提交 summary：逐页说明版式、原生可编辑元素、字体、配色、文字密度和图片安排。4 项优先两列完整排布，避免残缺网格，长中文精简或拆页。canvas 所有组件（含装饰）的区域满足 x>=0、y>=0、w>0、h>0、x+w<=1、y+h<=1，不使用负坐标或出血；文字块预留足够高度。随后据此生成完整 planJson。'
          : '提交 summary：说明 A4 页面、标题层级、段落、表格、目录、页眉页脚和分页方案。随后生成完整 planJson。',
      toolIds: [],
      outputSchema: summary,
      checks: ['schema'],
    },
    {
      id: 'plan',
      name: '方案预检与确认',
      operation: 'prepare',
      instructions: `调用 ${tool} action=plan，提交完整 planJson 和明确的 inputsJson。使用前面确认的来源，结构必须符合工具说明。此调用会由 Host 等待用户确认后生成，无需另外调用 execute。`,
      toolIds: [tool],
      outputSchema: schema,
      checks: ['schema', 'plan'],
    },
    {
      id: 'generate',
      name: '生成成果',
      operation: 'execute',
      instructions:
        '仅由当前有效方案确认触发真实生成。等待工具完成，不重复提交。',
      toolIds: [tool],
      outputSchema: schema,
      checks: ['schema', 'artifact'],
    },
    {
      id: 'review',
      name: '成果校验与交付',
      operation: 'review',
      instructions:
        '读取工具的实际预览和质量报告，提交 summary：页数或章节、已完成的检查及限制。校验失败时修订前面的方案，不能自报通过。交付当前会话成果入口，不编造链接。',
      toolIds: [],
      outputSchema: summary,
      checks: ['schema', 'artifact', 'rendered-quality'],
    },
  ]
  return withMultimodalTools({
    schemaVersion: 1,
    match: {
      phrases:
        kind === 'ppt'
          ? ['ppt', '演示', '幻灯片', '汇报']
          : ['word', 'docx', '报告', '制度', '方案书', '纪要'],
      excludePhrases: ['是什么', '如何使用工具'],
      inputExtensions: [],
      outputTypes: [kind === 'ppt' ? 'pptx' : 'docx'],
      examples:
        kind === 'ppt'
          ? ['把公司资料整理成 7 页客户演示']
          : ['将这些资料整理成带目录的正式方案书'],
    },
    stages,
    maxRevisions: 2,
    timeoutSeconds: 600,
  })
}
