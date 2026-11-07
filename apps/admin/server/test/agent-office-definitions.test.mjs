import assert from 'node:assert/strict'
import test from 'node:test'
import { checkAgentDefinitionReadiness } from '../agents/definition-readiness.ts'
import {
  isPristineLegacyExample,
  isPristineBuiltinResource,
  officeAgentExamples,
} from '../agents/demo-definitions.ts'
import { agentInput } from '../agents/validation.ts'
import {
  presentationSkills,
  presentationSkillIds,
} from '../agents/presentation-skills.ts'
import { skillPrompt } from '../agents/skill-prompt.ts'

const original = {
  id: 'old-excel',
  name: '经营分析助手',
  description:
    '使用星河商贸虚构销售台账，按公司模板生成可编辑 Excel。可换成你的 CSV/XLSX。',
  instructions:
    '先核对销售数据，生成经营分析Excel，概述地区、产品收入与毛利。默认公司名称为星河商贸（虚构演示）。',
  skillIds: ['sales-analysis'],
  toolIds: ['knowledge_search', 'spreadsheet_report'],
  knowledgeBaseIds: ['company', 'sales'],
  knowledgeAssetIds: [],
  templateAssetIds: [],
  published: true,
  version: 1,
}

test('pristine examples can upgrade in place but edited instructions, publication, associations and guidance remain owned', () => {
  assert.equal(isPristineLegacyExample(original, 0, ['company', 'sales']), true)
  for (const patch of [
    { instructions: '企业自己的规则' },
    { name: '我的 Excel' },
    { published: false },
    { knowledgeBaseIds: ['company'] },
    { templateAssetIds: ['custom'] },
    { recommendedPrompts: ['企业提示'] },
    { toolIds: ['spreadsheet_report'] },
  ])
    assert.equal(
      isPristineLegacyExample({ ...original, ...patch }, 0, [
        'company',
        'sales',
      ]),
      false,
    )
})

test('built-in resource upgrade checks complete content, not version alone', () => {
  const tool = {
    id: 'spreadsheet_report',
    name: '生成经营分析 Excel',
    description:
      '读取绑定资料或本会话附件中的销售表，按所选模板生成可下载的 Excel。',
    settings: {},
    enabled: true,
    version: 1,
  }
  assert.equal(isPristineBuiltinResource(tool), true)
  for (const patch of [
    { name: '公司工具' },
    { description: '定制行为' },
    { settings: { title: '内部报告' } },
    { enabled: false },
    { version: 2 },
  ])
    assert.equal(isPristineBuiltinResource({ ...tool, ...patch }), false)
})

test('all four configurable office examples provide guidance and prohibit implicit demonstration data', () => {
  assert.deepEqual(
    officeAgentExamples.map((item) => item.name),
    ['Excel 办公助手', 'PPT 演示助手', '企业知识助手', 'Word 文档助手'],
  )
  for (const example of officeAgentExamples) {
    assert.ok(example.recommendedPrompts.length >= 3)
    assert.ok(example.inputRequirements.length >= 2)
    assert.ok(example.outputExamples.length >= 2)
    const saved = agentInput({
      ...example,
      knowledgeBaseIds: [],
      knowledgeAssetIds: [],
      templateAssetIds: [],
      published: true,
    })
    assert.deepEqual(saved.recommendedPrompts, example.recommendedPrompts)
  }
  assert.match(officeAgentExamples[0].instructions, /只有用户明确要求/u)
  assert.match(officeAgentExamples[1].instructions, /只有用户明确选择/u)
})

test('guidance rejects invalid entries and oversized lists while old callers remain valid', () => {
  assert.deepEqual(agentInput(original).recommendedPrompts, [])
  assert.throws(
    () => agentInput({ ...original, recommendedPrompts: [''] }),
    /推荐指令/u,
  )
  assert.throws(
    () => agentInput({ ...original, outputExamples: Array(9).fill('x') }),
    /输出示例/u,
  )
  assert.throws(
    () => agentInput({ ...original, inputRequirements: ['x'.repeat(501)] }),
    /输入要求/u,
  )
})

test('publication checks distinguish optional inputs and live acceptance from invalid tools', () => {
  const example = officeAgentExamples[0]
  const resources = {
    knowledgeBases: [],
    skills: [
      {
        id: 'sales-analysis',
        name: '办公表格',
        enabled: true,
        requiredToolIds: ['spreadsheet_report'],
      },
    ],
    tools: [
      { id: 'knowledge_search', name: '检索', enabled: true },
      { id: 'spreadsheet_report', name: 'Excel', enabled: true },
    ],
  }
  const checked = checkAgentDefinitionReadiness(example, resources, [])
  assert.equal(checked.ready, true)
  assert.ok(
    checked.warnings.some((warning) => warning.includes('没有关联知识资料')),
  )
  assert.ok(checked.warnings.some((warning) => warning.includes('不代表模型')))
  assert.ok(!checked.errors.some((error) => error.includes('模板')))
  const disabled = checkAgentDefinitionReadiness(
    example,
    {
      ...resources,
      tools: resources.tools.map((tool) => ({ ...tool, enabled: false })),
    },
    [],
  )
  assert.equal(disabled.ready, false)
  assert.equal(disabled.errors.length, 2)
})

test('PPT uses three independently configurable skills and missing tool dependencies block publication', () => {
  const definition = officeAgentExamples[1]
  for (const id of presentationSkillIds)
    assert.ok(definition.skillIds.includes(id))
  const resources = {
    knowledgeBases: [],
    skills: [
      {
        id: 'company-knowledge',
        name: '资料',
        enabled: true,
        requiredToolIds: ['knowledge_search'],
      },
      ...presentationSkills.map((skill) => ({
        ...skill,
        enabled: true,
        requiredToolIds: ['presentation_report'],
      })),
    ],
    tools: definition.toolIds.map((id) => ({ id, name: id, enabled: true })),
  }
  assert.equal(
    checkAgentDefinitionReadiness(definition, resources, []).ready,
    true,
  )
  const checked = checkAgentDefinitionReadiness(
    {
      ...definition,
      toolIds: definition.toolIds.filter((id) => id !== 'presentation_report'),
    },
    resources,
    [],
  )
  assert.equal(checked.ready, false)
})

test('Host uses ordered frozen skill versions and fails when a selected snapshot is missing', () => {
  const skills = presentationSkills.map((skill) => ({
    ...skill,
    enabled: true,
    version: 3,
  }))
  skills[0].instructions = '客户自定义策划方法'
  const binding = {
    definition: { skillIds: [...presentationSkillIds] },
    skills: [...skills].reverse(),
  }
  const prompts = skillPrompt(binding)
  assert.match(prompts[0], /PPT 内容策划.*版本 3/u)
  assert.match(prompts[0], /客户自定义策划方法/u)
  assert.match(prompts[1], /PPT 版式设计/u)
  assert.match(prompts[2], /PPT 质量校验/u)
  assert.throws(
    () => skillPrompt({ ...binding, skills: skills.slice(1) }),
    /缺少配置/u,
  )
  assert.throws(
    () =>
      skillPrompt({
        ...binding,
        skills: skills.map((skill) => ({ ...skill, enabled: false })),
      }),
    /已停用/u,
  )
  assert.equal(
    skillPrompt({ definition: { skillIds: ['business-presentation'] } }).length,
    1,
  )
})
