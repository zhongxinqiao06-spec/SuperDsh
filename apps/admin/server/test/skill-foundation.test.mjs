import assert from 'node:assert/strict'
import test from 'node:test'
import {
  validateSkillProgram,
  validateSkillPolicy,
} from '../skills/definitions.ts'
import { matchSkills } from '../skills/matching.ts'
import {
  documentSkillProgram,
  withMultimodalTools,
} from '../../../desktop/core/src/client/skill-presets.ts'
import { skillPrompt } from '../agents/skill-prompt.ts'
import { skillControlParameters } from '../skills/host-parameters.mjs'
import { createRequire } from 'node:module'
import { officeJson } from '../agents/office-sources.ts'
import { pathToFileURL } from 'node:url'
import { SkillRuntime } from '../skills/runtime.ts'

const make = (id, kind) => ({
  id,
  name: id,
  description: id,
  enabled: true,
  program: documentSkillProgram(kind),
})

test('invalid plans identify syntax location without echoing private input', () => {
  const raw = '{"private":"synthetic-sensitive-value","rows":[["x"]}'
  assert.throws(
    () => officeJson(raw, '办公方案'),
    (error) => {
      assert.equal(error.status, 422)
      assert.match(error.message, /字符 \d+/)
      assert.doesNotMatch(error.message, /synthetic-sensitive/)
      return true
    },
  )
})
test('generic PPT/Word programs validate and match only eligible resources', () => {
  for (const kind of ['ppt', 'word'])
    assert.equal(
      validateSkillProgram(documentSkillProgram(kind)).stages.length,
      6,
    )
  const skills = [
    make('ppt', 'ppt'),
    make('word', 'word'),
    { ...make('disabled', 'ppt'), enabled: false },
  ]
  assert.equal(matchSkills(skills, '制作客户演示 PPT')[0].id, 'ppt')
  assert.equal(matchSkills(skills, '生成正式 Word 制度文档')[0].id, 'word')
  assert.equal(
    matchSkills(skills, 'PPT 是什么').every((item) => item.score === -1),
    true,
  )
  assert.equal(
    matchSkills(skills, 'PPT 是什么').find((item) => item.id === 'ppt').score,
    -1,
  )
  assert.equal(
    matchSkills(skills, '生成 PPT', [], { mode: 'fixed', fixedSkillId: 'word' })
      .length,
    1,
  )
  assert.equal(
    matchSkills(skills, '你好').every((item) => item.score === 0),
    true,
  )
})
test('definitions reject fabricated validators, arbitrary schemas and missing approval stages', () => {
  const base = documentSkillProgram('ppt')
  const attempt = (edit) => {
    const p = structuredClone(base)
    edit(p)
    assert.throws(() => validateSkillProgram(p))
  }
  attempt((p) => p.stages[0].checks.push('eval'))
  attempt((p) => p.stages[1].checks.push('sources'))
  attempt(
    (p) => (p.stages[1].outputSchema.$ref = 'https://attacker.invalid/schema'),
  )
  attempt((p) => p.stages.splice(3, 1))
  attempt((p) => (p.stages[2].id = p.stages[1].id))
  attempt((p) => (p.maxRevisions = 999))
  attempt((p) => (p.stages[0].inspectToolIds = ['image_generate']))
  assert.throws(() => validateSkillPolicy({ mode: 'fixed' }))
})

test('multimodal configuration is additive and repeatable for PPT and Word', () => {
  for (const kind of ['ppt', 'word']) {
    const program = documentSkillProgram(kind)
    program.stages[1].name = '企业定制策划'
    program.stages[1].instructions = '保留客户自己的工作方法'
    const updated = withMultimodalTools(program)
    assert.equal(updated.stages.length, program.stages.length)
    assert.equal(updated.stages[1].name, '企业定制策划')
    assert.match(updated.stages[1].instructions, /保留客户自己的工作方法/)
    assert.deepEqual(withMultimodalTools(updated), updated)
    assert.deepEqual(updated.stages[2].toolIds, [
      'illustration_render',
      'image_generate',
      'vision_analyze',
    ])
    assert.deepEqual(updated.stages[2].inspectToolIds, [
      kind === 'ppt' ? 'presentation_report' : 'document_report',
    ])
    assert.deepEqual(updated.stages[3], program.stages[3])
    validateSkillProgram(updated)
  }
})

test('final rendering evidence accepts mixed materials but never an image instead of a checked document', async () => {
  const runtime = new SkillRuntime({})
  const program = documentSkillProgram('ppt')
  const run = {
    program,
    stageIndex: 5,
    sessionId: 'synthetic',
    stages: [
      {
        calls: [
          { artifactIds: ['doc', 'image'] },
          { auxiliary: true, artifactIds: ['unused-image'] },
        ],
      },
    ],
  }
  const doc = {
    fileId: 'doc',
    name: '成果.pptx',
    quality: { status: 'passed' },
  }
  const image = { fileId: 'image', mediaType: 'image/png' }
  const check = async (artifacts) => {
    const checks = await runtime.checks(
      run,
      {
        summary:
          '检查真实保存的成果及渲染报告，不把素材文件冒充已通过校验的文档。',
      },
      {
        query: async (_sql, [, ids]) => {
          assert.deepEqual(ids, ['doc', 'image'])
          return artifacts.map((item) => ({
            metadata_json: JSON.stringify(item),
          }))
        },
      },
    )
    return checks.find((item) => item.validator === 'rendered-quality').passed
  }
  assert.equal(await check([doc, image]), true)
  assert.equal(await check([image]), false)
  assert.equal(await check([{ ...doc, quality: undefined }, image]), false)
  assert.equal(
    await check([{ ...doc, quality: { status: 'draft' } }, image]),
    false,
  )
})
test('auto mode loads candidate summaries instead of eagerly expanding every skill instruction', () => {
  const prompt = skillPrompt({
    definition: { skillPolicy: { mode: 'auto' }, skillIds: ['ppt'] },
    skills: [{ ...make('ppt', 'ppt'), instructions: 'PRIVATE_FULL_SKILL' }],
  }).join('\n')
  assert.match(prompt, /superdsh_skill/)
  assert.match(prompt, /ppt/)
  assert.doesNotMatch(prompt, /PRIVATE_FULL_SKILL/)
})

test('skill control compiles with the pinned real DSH tool schema DSL', async () => {
  const require = createRequire(
    new URL('../../../desktop/plugins/harness/package.json', import.meta.url),
  )
  const { parameterSchemaSpecToJsonSchema } = await import(
    pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')).href
  )
  const schema = parameterSchemaSpecToJsonSchema(skillControlParameters)
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.required, ['action', 'argumentsJson'])
  assert.equal(schema.properties.argumentsJson.type, 'string')
})
