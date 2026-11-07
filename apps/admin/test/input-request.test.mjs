import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildInputRequestPayload,
  createInputRequestDrafts,
  inputRequestIsComplete,
  readInputRequestForm,
} from '../src/components/session/input-request.ts'

function inputRequestNotice(questions) {
  return {
    noticeId: 'notice-1',
    type: 'interaction',
    sessionId: 'session-1',
    source: {},
    title: 'Questions',
    severity: 'info',
    status: 'open',
    interactionType: 'input_request',
    responseRequired: true,
    actions: [
      {
        actionId: 'submit',
        label: 'Submit',
        style: 'primary',
        input: {
          required: true,
          schema: {},
          uiSchema: { component: 'inputRequest', version: 1, questions },
        },
      },
      {
        actionId: 'cancel',
        label: 'Cancel',
        style: 'secondary',
        input: { required: false },
      },
    ],
    context: {},
    metadata: {},
    revision: 1,
    updatedSeq: 1,
    createdAt: '2026-08-28T00:00:00Z',
    updatedAt: '2026-08-28T00:00:00Z',
  }
}

test('input request schema becomes a complete structured response', () => {
  const notice = inputRequestNotice([
    {
      id: 'q_0',
      header: 'Runtime',
      prompt: 'Which runtime?',
      multiple: false,
      allowCustom: true,
      options: [
        { id: 'o_0', label: 'Codex', description: 'OpenAI' },
        { id: 'o_1', label: 'Claude' },
      ],
    },
    {
      id: 'q_1',
      prompt: 'Which checks?',
      multiple: true,
      allowCustom: true,
      options: [{ id: 'o_0', label: 'Tests' }],
    },
  ])
  const form = readInputRequestForm(notice)
  assert.ok(form)
  assert.equal(form.action.actionId, 'submit')
  assert.equal(form.questions[0].options[0].description, 'OpenAI')

  const drafts = createInputRequestDrafts(form)
  assert.equal(inputRequestIsComplete(form, drafts), false)
  drafts.q_0 = { optionIds: ['o_1'], customText: '', useCustom: false }
  drafts.q_1 = { optionIds: ['o_0'], customText: 'Lint', useCustom: true }

  assert.equal(inputRequestIsComplete(form, drafts), true)
  assert.deepEqual(buildInputRequestPayload(form, drafts), {
    answers: {
      q_0: { optionIds: ['o_1'] },
      q_1: { optionIds: ['o_0'], customText: 'Lint' },
    },
  })
})

test('input request parser rejects duplicate protocol ids', () => {
  const notice = inputRequestNotice([
    {
      id: 'q_0',
      prompt: 'Choose',
      options: [
        { id: 'o_0', label: 'One' },
        { id: 'o_0', label: 'Two' },
      ],
    },
  ])

  assert.equal(readInputRequestForm(notice), null)
})

test('office plan review preserves markdown and approve intent without selecting approval', () => {
  const notice = inputRequestNotice([
    {
      id: 'office-plan',
      prompt: '是否生成？\n\n## 数据来源\n\n- 季度表.xlsx',
      detail: '输入哈希：verified-hash',
      intent: { kind: 'plan-review', approveOptionId: 'approve' },
      multiple: false,
      allowCustom: true,
      options: [
        { id: 'revise', label: '修改方案' },
        { id: 'approve', label: '确认生成' },
      ],
    },
  ])
  const form = readInputRequestForm(notice)
  assert.deepEqual(form.questions[0].intent, {
    kind: 'plan-review',
    approveOptionId: 'approve',
  })
  assert.match(form.questions[0].prompt, /## 数据来源/u)
  assert.equal(form.questions[0].detail, '输入哈希：verified-hash')
  const draft = createInputRequestDrafts(form)
  assert.equal(inputRequestIsComplete(form, draft), false)
  assert.deepEqual(draft['office-plan'].optionIds, [])
  draft['office-plan'] = {
    optionIds: ['approve'],
    customText: '',
    useCustom: false,
  }
  assert.equal(inputRequestIsComplete(form, draft), true)
  assert.deepEqual(buildInputRequestPayload(form, draft), {
    answers: { 'office-plan': { optionIds: ['approve'] } },
  })
})

test('unknown approval targets do not create an actionable plan review', () => {
  const notice = inputRequestNotice([
    {
      id: 'plan',
      prompt: 'Review',
      options: [{ id: 'revise', label: '修改' }],
      intent: { kind: 'plan-review', approveOptionId: 'missing' },
    },
  ])
  assert.equal(readInputRequestForm(notice), null)
})
