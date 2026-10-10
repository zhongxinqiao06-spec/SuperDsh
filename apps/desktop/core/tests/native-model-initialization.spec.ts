import { expect, it, vi } from 'vitest'
import {
  initializeNativeSessionModel,
  nativeModelInitialization,
  NativeModelInitializationStore,
} from '../src/client/native-model-initialization.ts'
import type {
  PlatformAccountState,
  PlatformBridge,
  PlatformJson,
} from '../src/contracts/platform.ts'
const account: PlatformAccountState = {
  space: 'local',
  origin: 'https://platform.example',
  status: 'ready',
  identityKey: 'scope-a',
  identityGeneration: 1,
  user: {
    userId: 'alice',
    username: 'alice',
    email: null,
    displayName: 'Alice',
    roles: ['member'],
    permissions: [],
    authzVersion: 1,
    resetRequired: false,
  },
  connectorId: 'device',
  connectorRunning: true,
  error: null,
  localImportAvailable: false,
}
function bridge(
  catalog: PlatformJson,
  state = () => account,
): Pick<PlatformBridge, 'state' | 'request'> {
  return { state: async () => state(), request: async () => catalog }
}
it('initializes only a new session selection without writing a personal default', async () => {
  const select = vi.fn(async () => {})
  await initializeNativeSessionModel(
    bridge({
      scope: 'scope-a',
      default: { providerId: 'provider', modelId: 'model' },
    }) as PlatformBridge,
    account,
    'new-session',
    select,
  )
  expect(select).toHaveBeenCalledExactlyOnceWith({
    provider: 'superdsh-scope-a-provider',
    model: 'model',
  })
  expect(nativeModelInitialization.get('new-session')).toBeUndefined()
})
it('restores unresolved native model choices after a renderer reload and clears only an explicit choice', () => {
  const saved = new Map<string, string>()
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => {
      saved.set(key, value)
    },
  }
  const before = new NativeModelInitializationStore(storage)
  expect(
    before.set('local-native-session', {
      phase: 'pending',
      message: 'waiting',
      scope: 'scope-a',
    }),
  ).toBe(true)
  const reloaded = new NativeModelInitializationStore(storage)
  expect(reloaded.get('local-native-session')).toMatchObject({
    phase: 'error',
    scope: 'scope-a',
  })
  expect(reloaded.clear('local-native-session')).toBe(true)
  expect(
    new NativeModelInitializationStore(storage).get('local-native-session'),
  ).toBeUndefined()
  expect([...saved.values()].join('')).not.toContain('password')
})
it('keeps a model-choice block when its durable local marker cannot be saved or cleared', () => {
  let fail = false
  const storage = {
    getItem: () => null,
    setItem: () => {
      if (fail) throw new Error('storage unavailable')
    },
  }
  const model = new NativeModelInitializationStore(storage)
  model.set('local-native-session', {
    phase: 'error',
    message: 'choose a model',
  })
  fail = true
  expect(model.clear('local-native-session')).toBe(false)
  expect(model.get('local-native-session')?.message).toContain(
    '无法保存本机模型来源标记',
  )
  fail = false
  expect(model.clear('local-native-session')).toBe(true)
  expect(model.get('local-native-session')).toBeUndefined()
})
it('blocks first prompt on failed catalog until the user explicitly selects a model', async () => {
  const select = vi.fn(async () => {})
  await initializeNativeSessionModel(
    bridge({
      default: { providerId: 'provider', modelId: 'model' },
    }) as PlatformBridge,
    account,
    'failed-session',
    select,
  )
  expect(select).not.toHaveBeenCalled()
  expect(nativeModelInitialization.get('failed-session')?.phase).toBe('error')
  nativeModelInitialization.clear('failed-session')
  expect(nativeModelInitialization.get('failed-session')).toBeUndefined()
})
it('refuses to apply a late default after a platform identity switch', async () => {
  let current = account
  const select = vi.fn(async () => {})
  const platform = bridge(null, () => current)
  platform.request = async () => {
    current = { ...account, identityKey: 'scope-b', identityGeneration: 2 }
    return {
      scope: 'scope-a',
      default: { providerId: 'provider', modelId: 'model' },
    }
  }
  await initializeNativeSessionModel(
    platform as PlatformBridge,
    account,
    'switched-session',
    select,
  )
  expect(select).not.toHaveBeenCalled()
  expect(nativeModelInitialization.get('switched-session')?.message).toContain(
    '平台账号已切换',
  )
  nativeModelInitialization.clear('switched-session')
})
