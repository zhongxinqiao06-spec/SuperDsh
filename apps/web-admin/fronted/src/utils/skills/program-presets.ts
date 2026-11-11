import type { SkillProgram, SkillStage } from '@/types/skills/skills'
import type { JsonSchema } from '@/types/tools/tools'
import { emptyProgram } from './program'
import presets from '@/assets/skills/program-presets.json'

/** 显式补齐辅助工具，保持已有阶段和指令；这是配置编辑，不启动工具或授予执行权限。 */
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

/** 可编辑起点由资源数据声明，复制后仅修改当前草稿；执行仍由通用技能协议解释。 */
export function documentSkillProgram(kind: keyof typeof presets): SkillProgram {
  const preset = structuredClone(presets[kind])
  return {
    ...preset,
    schemaVersion: emptyProgram().schemaVersion,
    stages: preset.stages.map((stage) => {
      // JSON 联合推断可能为不存在的属性补 undefined；明确筛除后保持 Schema 字段契约。
      const properties: Record<string, JsonSchema> = {}
      for (const [name, schema] of Object.entries(
        stage.outputSchema.properties,
      ))
        if (schema) properties[name] = schema
      return {
        ...stage,
        operation: stageOperation(stage.operation),
        outputSchema: { ...stage.outputSchema, properties },
        inspectToolIds: [...(stage.inspectToolIds ?? [])],
      }
    }),
  }
}

function stageOperation(value: string): SkillStage['operation'] {
  if (
    value === 'submit' ||
    value === 'inspect' ||
    value === 'prepare' ||
    value === 'execute' ||
    value === 'review'
  )
    return value
  throw new Error(`技能起点包含不支持的阶段操作：${value}`)
}
