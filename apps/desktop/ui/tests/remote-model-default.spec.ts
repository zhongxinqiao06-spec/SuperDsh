import { expect, it } from 'vitest'
import { remotePlatformDefault } from '../src/features/platform/remote-model-default.ts'
const selected = { providerId: 'provider', modelId: 'model' }
const model = (scope: string) => ({
  id:
    'dsh:model:' +
    Buffer.from(
      JSON.stringify([
        'superdsh-' + scope.repeat(64) + '-provider',
        'model',
        null,
      ]),
    ).toString('base64url'),
  metadata: {
    provider: 'superdsh-' + scope.repeat(64) + '-provider',
    model: 'model',
  },
})
it('chooses the target device route even when it uses another origin alias scope', () => {
  const target = model('b')
  expect(
    remotePlatformDefault(
      [
        target,
        {
          id: 'personal',
          metadata: { provider: 'personal-provider', model: 'model' },
        },
      ],
      selected,
    ),
  ).toBe(target)
})
it('does not silently choose a fee source from missing or ambiguous remote routes', () => {
  expect(remotePlatformDefault([], selected)).toBeUndefined()
  expect(
    remotePlatformDefault([model('a'), model('b')], selected),
  ).toBeUndefined()
})

it('selects the default reasoning entry rather than a fee source variant', () => {
  const target = model('b')
  expect(
    remotePlatformDefault(
      [
        {
          ...target,
          id: 'explicit-reasoning-variant',
          metadata: { ...target.metadata, reasoningEffort: 'high' },
        },
        target,
      ],
      selected,
    ),
  ).toBe(target)
})
