import type { SkillPolicy, SkillProgram } from '@superdsh/core/contracts/skills'
import { ApiError, object, requiredText } from '../http/api-router.ts'
import { extensionId, validateSchema } from '../extensions/validation.ts'

const strings = (value: unknown, label: string, max = 30): string[] => {
  if (!Array.isArray(value) || value.length > max)
    throw new ApiError(422, `${label}必须是至多 ${max} 项的列表`)
  return [
    ...new Set(
      value
        .filter((item) => typeof item !== 'string' || item.trim())
        .map((item) => requiredText(item, label, 300).trim()),
    ),
  ]
}
export function validateSkillPolicy(value: unknown): SkillPolicy | undefined {
  if (value === undefined) return undefined
  const input = object(value)
  if (!['legacy', 'auto', 'fixed'].includes(String(input.mode)))
    throw new ApiError(422, '无效技能选择策略')
  return {
    mode: input.mode as SkillPolicy['mode'],
    ...(input.mode === 'fixed'
      ? { fixedSkillId: requiredText(input.fixedSkillId, '固定技能', 160) }
      : {}),
  }
}
export function validateSkillProgram(value: unknown): SkillProgram {
  const input = object(value),
    match = object(input.match)
  if (input.schemaVersion !== 1) throw new ApiError(422, '不支持的技能程序版本')
  if (
    !Array.isArray(input.stages) ||
    !input.stages.length ||
    input.stages.length > 20
  )
    throw new ApiError(422, '技能需要 1–20 个有序阶段')
  const stages = input.stages.map((raw) => {
    const stage = object(raw)
    if (
      !['submit', 'inspect', 'prepare', 'execute', 'review'].includes(
        String(stage.operation),
      )
    )
      throw new ApiError(422, '无效阶段操作')
    const checks = strings(stage.checks ?? ['schema'], '校验器')
    if (
      checks.some(
        (check) =>
          ![
            'schema',
            'sources',
            'plan',
            'artifact',
            'rendered-quality',
          ].includes(check),
      )
    )
      throw new ApiError(422, '未注册的校验器')
    const operation =
      stage.operation as SkillProgram['stages'][number]['operation']
    if (
      (checks.includes('sources') && operation !== 'inspect') ||
      (checks.includes('plan') && operation !== 'prepare')
    )
      throw new ApiError(422, '资料和方案证据必须来自对应的真实工具阶段')
    const toolIds = strings(stage.toolIds ?? [], '阶段工具')
    const inspectToolIds = strings(stage.inspectToolIds ?? [], '辅助检查工具')
    if (inspectToolIds.length && operation !== 'submit')
      throw new ApiError(422, '辅助检查工具只能配置在提交阶段')
    if (
      ['inspect', 'prepare', 'execute'].includes(operation) &&
      !toolIds.length
    )
      throw new ApiError(422, '工具阶段必须指定授权工具')
    return {
      id: extensionId(stage.id, '阶段标识'),
      name: requiredText(stage.name, '阶段名称', 100),
      instructions: requiredText(stage.instructions, '阶段指令', 6000),
      ...(stage.skillId
        ? { skillId: requiredText(stage.skillId, '引用技能', 160) }
        : {}),
      operation,
      toolIds,
      ...(inspectToolIds.length ? { inspectToolIds } : {}),
      outputSchema: validateSchema(stage.outputSchema, '阶段输出'),
      checks: checks as SkillProgram['stages'][number]['checks'],
    }
  })
  if (new Set(stages.map((stage) => stage.id)).size !== stages.length)
    throw new ApiError(422, '阶段标识不能重复')
  // A generation stage must consume the immediately preceding confirmed plan.
  for (const [index, stage] of stages.entries()) {
    if (
      stage.operation === 'execute' &&
      (stages[index - 1]?.operation !== 'prepare' ||
        stage.toolIds.some((id) => !stages[index - 1]!.toolIds.includes(id)))
    )
      throw new ApiError(422, '生成阶段必须紧接同一工具的方案确认阶段')
    if (
      stage.operation === 'prepare' &&
      stages[index + 1]?.operation !== 'execute'
    )
      throw new ApiError(422, '方案确认后必须配置生成阶段')
  }
  const maxRevisions = Number(input.maxRevisions ?? 2),
    timeoutSeconds = Number(input.timeoutSeconds ?? 600)
  if (
    !Number.isInteger(maxRevisions) ||
    maxRevisions < 0 ||
    maxRevisions > 5 ||
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 30 ||
    timeoutSeconds > 3600
  )
    throw new ApiError(422, '技能修订次数或执行时限无效')
  return {
    schemaVersion: 1,
    match: {
      phrases: strings(match.phrases ?? [], '匹配词'),
      excludePhrases: strings(match.excludePhrases ?? [], '排除词'),
      inputExtensions: strings(match.inputExtensions ?? [], '输入类型'),
      outputTypes: strings(match.outputTypes ?? [], '输出类型'),
      examples: strings(match.examples ?? [], '匹配示例', 10),
    },
    stages,
    maxRevisions,
    timeoutSeconds,
  }
}
