import assert from 'node:assert/strict'
import test from 'node:test'
import { visionResponse } from '../models/vision-response.ts'
import { validateModelParameters } from '../models/capabilities.ts'

test('Ark vision defaults to a bounded non-thinking answer and accepts an explicit thinking policy', () => {
  const parameters = validateModelParameters(
    'volcengine-ark',
    'vision.analyze',
    'doubao-seed-2.1-pro',
    {},
  )
  assert.equal(parameters.thinking, 'disabled')
  assert.equal(
    validateModelParameters(
      'volcengine-ark',
      'vision.analyze',
      'doubao-seed-2.1-pro',
      { thinking: 'enabled' },
    ).thinking,
    'enabled',
  )
  assert.throws(
    () =>
      validateModelParameters(
        'volcengine-ark',
        'vision.analyze',
        'doubao-seed-2.1-pro',
        { thinking: 'unknown' },
      ),
    /不受支持/,
  )
  assert.throws(
    () =>
      validateModelParameters('openai-responses', 'vision.analyze', 'vision', {
        thinking: 'enabled',
      }),
    /不支持/,
  )
  assert.equal(
    validateModelParameters('openai-responses', 'vision.analyze', 'vision', {})
      .thinking,
    undefined,
  )
})

test('vision rejects a 200 response whose output budget was entirely consumed by reasoning', () => {
  assert.throws(
    () =>
      visionResponse({
        status: 'incomplete',
        incomplete_details: { reason: 'length' },
        usage: {
          output_tokens: 4096,
          output_tokens_details: { reasoning_tokens: 4096 },
        },
        output: [{ type: 'reasoning', status: 'incomplete' }],
      }),
    /推理也占用输出额度/,
  )
  assert.throws(
    () =>
      visionResponse({
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'partial' }],
          },
        ],
      }),
    /未得到完整回答/,
  )
  assert.throws(
    () =>
      visionResponse({
        choices: [{ finish_reason: 'length', message: { content: 'partial' } }],
      }),
    /输出上限/,
  )
})

test('vision exposes only completed answer text, never reasoning or a refused response', () => {
  assert.equal(
    visionResponse({
      status: 'completed',
      output: [
        {
          type: 'reasoning',
          content: [{ type: 'output_text', text: 'private reasoning' }],
        },
        {
          type: 'message',
          content: [{ type: 'output_text', text: '图中有蓝色文档架。' }],
        },
      ],
    }),
    '图中有蓝色文档架。',
  )
  assert.equal(
    visionResponse({
      choices: [
        { finish_reason: 'stop', message: { content: 'Visible laptop.' } },
      ],
    }),
    'Visible laptop.',
  )
  assert.throws(
    () =>
      visionResponse({
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [{ type: 'refusal', refusal: 'refused' }],
          },
        ],
      }),
    /有效正文/,
  )
})
