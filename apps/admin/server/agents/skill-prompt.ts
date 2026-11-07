import { agentSkills, type AgentBinding } from './contracts.ts'

/** Use the session snapshot in configured order; never replace it with current defaults. */
export function skillPrompt(
  binding: Pick<AgentBinding, 'definition' | 'skills'>,
) {
  if (
    binding.definition.skillPolicy &&
    binding.definition.skillPolicy.mode !== 'legacy'
  )
    return [
      '本智能体采用分阶段技能。处理文档制作或修订任务前先调用 superdsh_skill(action=match)，在候选中选择适合需求的技能并 start。普通问答无需启动。候选有歧义时先向用户询问。',
      '启动后只执行 currentStage。submit/review 阶段用 superdsh_skill 提交结构化 output；inspect/prepare/execute 阶段用其列出的真实工具。每次操作后用 status 读取最新 version 和阶段，不跳阶段、不虚报完成。工具 plan 会在一次调用内等待用户确认并执行，无需另发 execute。',
      '需要修订时用 revise 指定此前的输入、策划、排版或方案阶段，并保留旧成果。不要直接重放不明结果的收费调用。用户明确结束当前技能或开始新任务时，可先 cancel 未完成的技能再 start 新记录；不能自行取消以规避修订上限。最终 review 必须读取真实成果校验。',
      `可用技能摘要：${JSON.stringify((binding.skills ?? []).filter((skill) => binding.definition.skillIds.includes(skill.id) && skill.program).map(({ id, name, description, program }) => ({ id, name, description, match: program!.match })))}`,
    ]
  const skills = binding.skills ?? agentSkills
  return binding.definition.skillIds.map((id) => {
    const skill = skills.find((entry) => entry.id === id)
    if (!skill)
      throw new Error(`会话绑定的技能 ${id} 缺少配置，请重新绑定智能体`)
    if ('enabled' in skill && !skill.enabled)
      throw new Error(`会话绑定的技能 ${skill.name} 已停用`)
    return [
      `已绑定技能：${skill.name}（${skill.id}，版本 ${'version' in skill ? skill.version : '旧版兼容'}）`,
      skill.instructions,
    ].join('\n')
  })
}
