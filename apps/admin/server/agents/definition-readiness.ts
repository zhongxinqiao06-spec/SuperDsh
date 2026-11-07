import type { AgentDefinition } from './contracts.ts'
import type { AgentResourceCatalog } from './resource-contracts.ts'

export interface AgentReadiness {
  ready: boolean
  errors: string[]
  warnings: string[]
  checks: {
    id: string
    status: 'pass' | 'warning' | 'error'
    message: string
  }[]
}

/** Configuration preflight only. A passing result is not a real model/runtime test. */
export function checkAgentDefinitionReadiness(
  definition: Pick<
    AgentDefinition,
    | 'description'
    | 'instructions'
    | 'toolIds'
    | 'skillIds'
    | 'skillPolicy'
    | 'recommendedPrompts'
    | 'inputRequirements'
    | 'outputExamples'
  >,
  resources: AgentResourceCatalog,
  assets: { id: unknown; kind: unknown; name: unknown }[],
): AgentReadiness {
  const checks: AgentReadiness['checks'] = []
  const add = (
    id: string,
    status: 'pass' | 'warning' | 'error',
    message: string,
  ) => checks.push({ id, status, message })
  if (definition.skillPolicy && definition.skillPolicy.mode !== 'legacy') {
    const programs = resources.skills.filter(
      (skill) =>
        definition.skillIds.includes(skill.id) &&
        skill.enabled &&
        skill.program,
    )
    const valid =
      programs.length > 0 &&
      (definition.skillPolicy.mode !== 'fixed' ||
        programs.some(
          (skill) => skill.id === definition.skillPolicy!.fixedSkillId,
        ))
    add(
      'skill-policy',
      valid ? 'pass' : 'error',
      valid
        ? '已关联发布的阶段技能；执行阶段、工具与校验由服务端约束'
        : '自动匹配或固定执行需要关联已发布的阶段技能',
    )
  }
  for (const id of definition.toolIds) {
    const tool = resources.tools.find((item) => item.id === id)
    add(
      `tool:${id}`,
      tool?.enabled ? 'pass' : 'error',
      tool?.enabled ? `工具已启用：${tool.name}` : `工具不可用：${id}`,
    )
  }
  for (const id of definition.skillIds) {
    const skill = resources.skills.find((item) => item.id === id)
    if (!skill?.enabled) add(`skill:${id}`, 'error', `技能不可用：${id}`)
    else {
      const missing = skill.requiredToolIds.filter(
        (tool) => !definition.toolIds.includes(tool),
      )
      add(
        `skill:${id}`,
        missing.length ? 'error' : 'pass',
        missing.length
          ? `${skill.name} 缺少必需工具：${missing.join('、')}`
          : `技能配置有效：${skill.name}`,
      )
    }
  }
  add(
    'purpose',
    definition.description.trim() ? 'pass' : 'warning',
    definition.description.trim()
      ? '已说明用途与受众'
      : '建议补充用途，让使用者知道何时选择此智能体',
  )
  add(
    'prompts',
    definition.recommendedPrompts?.length ? 'pass' : 'warning',
    definition.recommendedPrompts?.length
      ? '已提供推荐指令'
      : '建议添加推荐指令，方便开始真实试用',
  )
  add(
    'input',
    definition.inputRequirements?.length ? 'pass' : 'warning',
    definition.inputRequirements?.length
      ? '已说明输入要求'
      : '建议说明输入文件、格式和必要字段',
  )
  add(
    'output',
    definition.outputExamples?.length ? 'pass' : 'warning',
    definition.outputExamples?.length
      ? '已说明输出示例'
      : '建议说明输出内容和可修改范围',
  )
  if (definition.toolIds.includes('knowledge_search')) {
    const hasKnowledge = assets.some((asset) => asset.kind === 'knowledge')
    add(
      'knowledge',
      hasKnowledge ? 'pass' : 'warning',
      hasKnowledge
        ? '已关联知识资料；检索前仍需索引就绪'
        : '没有关联知识资料，企业知识问答暂时无法提供公司依据',
    )
  }
  const office = resources.tools.some(
    (tool) =>
      definition.toolIds.includes(tool.id) &&
      tool.descriptor?.mode === 'office',
  )
  if (office)
    add(
      'office-input',
      'pass',
      '办公任务使用用户明确选择的资料或确认的新建内容；没有模板也可生成，模板不是发布必需条件',
    )
  if (!definition.toolIds.length)
    add(
      'tools',
      'warning',
      '未关联工具，只能进行普通模型对话，不能检索资料或生成办公成果',
    )
  add(
    'trial',
    'warning',
    '配置检查不代表模型或运行环境已通过验证。发布后请从“试用”进入工作台完成一次真实任务；不会自动发送或消耗模型额度',
  )
  const errors = checks
    .filter((item) => item.status === 'error')
    .map((item) => item.message)
  return {
    ready: !errors.length,
    checks,
    errors,
    warnings: checks
      .filter((item) => item.status === 'warning')
      .map((item) => item.message),
  }
}
