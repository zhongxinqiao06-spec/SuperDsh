import { describe, expect, it } from 'vitest'
import {
  documentSkillProgram as legacyProgram,
  withMultimodalTools as legacyMultimodal,
} from '../../../desktop/core/src/client/skill-presets'
import {
  documentSkillProgram,
  withMultimodalTools,
} from '@/utils/skills/program-presets'
import { programToolDependencies } from '@/utils/skills/program'

/** 对照旧公共配置方法的真实输出，避免模板迁移只验证新实现自身。 */
describe('技能起点配置差分', () => {
  for (const kind of ['ppt', 'word'] as const)
    it(`${kind} 保留全部匹配、阶段、确认与成果校验配置`, () => {
      const expected = legacyProgram(kind)
      expect(documentSkillProgram(kind)).toEqual({
        ...expected,
        stages: expected.stages.map((stage) => ({
          ...stage,
          inspectToolIds: stage.inspectToolIds ?? [],
        })),
      })
    })
  it('辅助工具补齐幂等且保留自定义阶段、匹配和已有授权', () => {
    const program = documentSkillProgram('word')
    program.match.phrases = ['自定义']
    program.stages[1]!.instructions = '用户自定义指令'
    const before = structuredClone(program)
    const updated = withMultimodalTools(program)
    const legacy = legacyProgram('word')
    legacy.match.phrases = ['自定义']
    legacy.stages[1]!.instructions = '用户自定义指令'
    const expected = legacyMultimodal(legacy)
    expect(updated).toEqual({
      ...expected,
      stages: expected.stages.map((stage) => ({
        ...stage,
        inspectToolIds: stage.inspectToolIds ?? [],
      })),
    })
    expect(withMultimodalTools(updated)).toEqual(updated)
    expect(program).toEqual(before)
    expect(programToolDependencies(updated, [])).toEqual(
      expect.arrayContaining([
        'document_report',
        'vision_analyze',
        'image_generate',
      ]),
    )
  })
})
