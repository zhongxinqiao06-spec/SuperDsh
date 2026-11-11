import type { SkillProgram, SkillStage } from '@/types/skills/skills'
import type { SelectableResource } from '@/types/agents/agents'
/** 编辑阶段时仅补入其显式依赖，撤销阶段不擅自删除用户已有的工具选择。 */
export function programToolDependencies(
  program: SkillProgram | null | undefined,
  skills: SelectableResource[],
): string[] {
  return [
    ...new Set(
      program?.stages.flatMap((stage) => [
        ...stage.toolIds,
        ...(stage.inspectToolIds ?? []),
        ...(skills.find((skill) => skill.id === stage.skillId)
          ?.requiredToolIds ?? []),
      ]) ?? [],
    ),
  ]
}
/** 技能声明的协议代际属于既有资源契约，不跟随应用发布版本。 */
export function emptyProgram(): SkillProgram {
  return {
    schemaVersion: 1,
    match: {
      phrases: [],
      excludePhrases: [],
      inputExtensions: [],
      outputTypes: [],
      examples: [],
    },
    stages: [],
    maxRevisions: 2,
    timeoutSeconds: 600,
  }
}
export function newStage(stages: SkillStage[]): SkillStage {
  let index = stages.length + 1
  while (stages.some((stage) => stage.id === `stage_${index}`)) index++
  return {
    id: `stage_${index}`,
    name: '',
    instructions: '',
    operation: 'submit',
    toolIds: [],
    inspectToolIds: [],
    outputSchema: { type: 'object' },
    checks: ['schema'],
  }
}
export function validateProgram(
  program: SkillProgram | null | undefined,
): string | null {
  if (!program) return null
  if (!program.stages.length)
    return '程序至少需要一个阶段 / Add at least one stage'
  const ids = new Set<string>()
  for (const [index, stage] of program.stages.entries()) {
    if (
      !stage.name.trim() ||
      !stage.instructions.trim() ||
      !/^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$/u.test(stage.id) ||
      ids.has(stage.id)
    )
      return '阶段标识须唯一且名称与指令必填 / Stages need unique IDs, names and instructions'
    ids.add(stage.id)
    if (
      ['inspect', 'prepare', 'execute'].includes(stage.operation) &&
      !stage.toolIds.length
    )
      return '工具阶段必须选择工具 / Tool stages require tools'
    if (
      stage.operation === 'prepare' &&
      program.stages[index + 1]?.operation !== 'execute'
    )
      return '准备阶段后必须紧接执行阶段 / Prepare must be followed by execute'
    if (
      stage.operation === 'execute' &&
      (program.stages[index - 1]?.operation !== 'prepare' ||
        stage.toolIds.some(
          (id) => !program.stages[index - 1]?.toolIds.includes(id),
        ))
    )
      return '执行阶段必须使用前一准备阶段的工具 / Execute must use tools from the preceding prepare stage'
  }
  return null
}
