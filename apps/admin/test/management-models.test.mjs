import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { registerSource } from './helpers/onboarding-source.mjs'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://app.example.test/',
  pretendToBeVisual: true,
})
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'Element',
  'Node',
  'getComputedStyle',
])
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: dom.window[key],
  })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const hooks = registerSource()
const { ModelsPanel } =
  await import('../src/components/management/models-panel.tsx')
const { RolesPanel } =
  await import('../src/components/management/roles-panel.tsx')
const { modelsApi, personalModelsApi } =
  await import('../src/features/management/models-api.ts')
const { managementApi } = await import('../src/features/management/api.ts')
const { saveStoredSession, clearStoredSession } =
  await import('../src/features/auth/session.ts')
hooks.deregister()
const provider = {
  providerId: 'platform-provider',
  name: 'Platform model',
  baseUrl: 'https://inference.example/v1',
  protocol: 'openai-completions',
  enabled: true,
  apiKeyConfigured: true,
  models: [
    {
      modelId: 'model-one',
      name: 'Model One',
      contextWindow: 100000,
      maxTokens: 16000,
      inputTypes: ['text'],
    },
  ],
}

async function mount(t, component) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () =>
    root.render(
      h(NextIntlClientProvider, { locale: 'en', messages: {} }, h(component)),
    ),
  )
  t.after(async () => {
    await act(async () => root.unmount())
    container.remove()
    clearStoredSession()
  })
  return container
}

async function click(container, label) {
  const button = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === label,
  )
  assert.ok(button, `Missing button: ${label}`)
  assert.equal(button.disabled, false)
  await act(async () => button.click())
}

async function fill(input, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    ).set.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

function field(container, title, index = 0) {
  const labels = [...container.querySelectorAll('label')].filter((label) => {
    const text = [...label.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent)
      .join('')
      .trim()
    return text === title || text.startsWith(`${title} · `)
  })
  const input = labels[index]?.querySelector('input, select')
  assert.ok(input, `Missing field: ${title} (${index})`)
  return input
}

async function select(input, value) {
  await act(async () => {
    input.value = value
    input.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
}

const deepseekDraft = {
  name: 'DeepSeek',
  protocol: 'openai-completions',
  baseUrl: 'https://api.deepseek.com',
  enabled: true,
  models: [
    {
      modelId: 'deepseek-flash',
      name: 'DeepSeek-V4.1-Flash',
      inputTypes: ['text', 'image'],
    },
    {
      modelId: 'deepseek-v4-pro',
      name: 'DeepSeek-V4-Pro',
      inputTypes: ['text'],
    },
  ],
}
const deepseekProvider = {
  ...deepseekDraft,
  providerId: 'created-deepseek-provider',
  apiKeyConfigured: true,
}

function mockModels(t, selection = null) {
  t.mock.method(modelsApi, 'providers', async () => ({
    providers: [structuredClone(provider)],
  }))
  t.mock.method(modelsApi, 'defaultSelection', async () => ({
    selection,
  }))
}

for (const scope of ['platform', 'personal']) {
  test(`${scope} providers can be created from only a key and select the returned provider as default`, async (t) => {
    if (scope === 'personal')
      saveStoredSession({
        userId: 'personal-owner',
        accessToken: 'synthetic-token',
        role: 'member',
        roles: ['member'],
        authzVersion: 1,
        permissions: ['models.personal.manage'],
      })
    const api = scope === 'personal' ? personalModelsApi : modelsApi
    t.mock.method(api, 'providers', async () => ({ providers: [] }))
    t.mock.method(api, 'defaultSelection', async () => ({ selection: null }))
    const saved = t.mock.method(api, 'save', async () => deepseekProvider)
    const selected = t.mock.method(api, 'setDefault', async () => ({}))
    const container = await mount(t, () => h(ModelsPanel, { scope }))
    await click(container, 'Add provider')
    assert.equal(field(container, 'Provider').value, 'deepseek')
    assert.equal(field(container, 'Name').value, 'DeepSeek')
    assert.equal(field(container, 'API protocol').value, 'openai-completions')
    assert.equal(
      field(container, 'API base URL').value,
      'https://api.deepseek.com',
    )
    assert.equal(field(container, 'Model ID').value, 'deepseek-flash')
    assert.equal(field(container, 'Model ID', 1).value, 'deepseek-v4-pro')
    assert.equal(field(container, 'Set as default model').checked, true)
    const key = container.querySelector('input[type="password"]')
    assert.equal(key.value, '')
    assert.equal(key.required, true)
    assert.equal(
      [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'Save',
      ).disabled,
      true,
    )
    assert.equal(saved.mock.callCount(), 0)
    await fill(key, '  synthetic-test-only  ')
    await click(container, 'Save')
    assert.deepEqual(saved.mock.calls[0].arguments, [
      null,
      { ...deepseekDraft, apiKey: 'synthetic-test-only' },
    ])
    assert.deepEqual(selected.mock.calls[0].arguments, [
      { providerId: deepseekProvider.providerId, modelId: 'deepseek-flash' },
    ])
    assert.equal(container.querySelector('form'), null)
    assert.equal(container.textContent.includes('synthetic-test-only'), false)
  })
}

test('adding a provider preserves an existing default unless explicitly selected', async (t) => {
  mockModels(t, { providerId: provider.providerId, modelId: 'model-one' })
  const saved = t.mock.method(modelsApi, 'save', async () => deepseekProvider)
  const selected = t.mock.method(modelsApi, 'setDefault', async () => ({}))
  const container = await mount(t, ModelsPanel)
  await click(container, 'Add provider')
  assert.equal(field(container, 'Set as default model').checked, false)
  await fill(container.querySelector('input[type="password"]'), 'synthetic-key')
  await click(container, 'Save')
  assert.equal(saved.mock.callCount(), 1)
  assert.equal(selected.mock.callCount(), 0)
  assert.match(container.textContent, /Platform default model: Model One/)
})

test('switching presets resets the draft and unsaved key, while custom providers remain configurable', async (t) => {
  mockModels(t)
  const saved = t.mock.method(modelsApi, 'save', async () => provider)
  const selected = t.mock.method(modelsApi, 'setDefault', async () => ({}))
  const container = await mount(t, ModelsPanel)
  await click(container, 'Add provider')
  await fill(
    container.querySelector('input[type="password"]'),
    'deepseek-unsaved-key',
  )
  await select(field(container, 'Provider'), 'custom')
  assert.equal(field(container, 'Name').value, '')
  assert.equal(field(container, 'API base URL').value, '')
  assert.equal(field(container, 'Model ID').value, '')
  assert.equal(
    container.querySelectorAll('fieldset fieldset input[type="checkbox"]')
      .length,
    1,
  )
  assert.equal(container.querySelector('input[type="password"]').value, '')
  await fill(field(container, 'Name'), 'Custom provider')
  await fill(field(container, 'API base URL'), 'https://custom.example.test/v1')
  await fill(
    container.querySelector('input[type="password"]'),
    'custom-unsaved-key',
  )
  await select(field(container, 'Provider'), 'deepseek')
  assert.equal(field(container, 'Name').value, 'DeepSeek')
  assert.equal(
    field(container, 'API base URL').value,
    'https://api.deepseek.com',
  )
  assert.equal(field(container, 'Model ID', 1).value, 'deepseek-v4-pro')
  assert.equal(container.querySelector('input[type="password"]').value, '')
  await select(field(container, 'Provider'), 'custom')
  await fill(field(container, 'Name'), 'Custom provider')
  await select(field(container, 'API protocol'), 'anthropic-messages')
  await fill(field(container, 'API base URL'), 'https://custom.example.test/v1')
  await fill(field(container, 'Model ID'), 'custom-model')
  await fill(
    container.querySelector('input[type="password"]'),
    'custom-save-key',
  )
  await act(async () => field(container, 'Set as default model').click())
  await click(container, 'Save')
  assert.deepEqual(saved.mock.calls[0].arguments, [
    null,
    {
      name: 'Custom provider',
      protocol: 'anthropic-messages',
      baseUrl: 'https://custom.example.test/v1',
      enabled: true,
      models: [
        { modelId: 'custom-model', name: 'custom-model', inputTypes: ['text'] },
      ],
      apiKey: 'custom-save-key',
    },
  ])
  assert.equal(selected.mock.callCount(), 0)
  await click(container, 'Add provider')
  assert.equal(field(container, 'Provider').value, 'deepseek')
  assert.equal(container.querySelector('input[type="password"]').value, '')
  await fill(container.querySelector('input[type="password"]'), 'cancelled-key')
  await click(container, 'Cancel')
  await click(container, 'Add provider')
  assert.equal(container.querySelector('input[type="password"]').value, '')
})

test('a default selection failure keeps the created provider editable without creating it or sending its key again', async (t) => {
  mockModels(t)
  const saved = t.mock.method(modelsApi, 'save', async () => deepseekProvider)
  const selected = t.mock.method(modelsApi, 'setDefault', async () => {
    throw new Error('Default selection failed')
  })
  const container = await mount(t, ModelsPanel)
  await click(container, 'Add provider')
  await fill(
    container.querySelector('input[type="password"]'),
    'synthetic-once-key',
  )
  await click(container, 'Save')
  assert.equal(saved.mock.callCount(), 1)
  assert.equal(saved.mock.calls[0].arguments[0], null)
  assert.equal(selected.mock.callCount(), 1)
  assert.match(
    container.querySelector('[role="alert"]').textContent,
    /Default selection failed/,
  )
  assert.match(container.querySelector('form').textContent, /Edit provider/)
  assert.equal(container.querySelector('input[type="password"]').value, '')
  assert.equal(
    container.querySelector('input[type="password"]').required,
    false,
  )
  await click(container, 'Save')
  assert.equal(saved.mock.calls[1].arguments[0], deepseekProvider.providerId)
  assert.equal('apiKey' in saved.mock.calls[1].arguments[1], false)
})

test('pending saves lock the draft and other provider editors through a default selection failure', async (t) => {
  mockModels(t)
  let finishSave
  const pendingSave = new Promise((resolve) => {
    finishSave = resolve
  })
  const saved = t.mock.method(modelsApi, 'save', () => pendingSave)
  let defaultAttempts = 0
  const selected = t.mock.method(modelsApi, 'setDefault', async () => {
    if (++defaultAttempts === 1) throw new Error('Default selection failed')
    return {}
  })
  const container = await mount(t, ModelsPanel)
  await click(container, 'Add provider')
  const key = container.querySelector('input[type="password"]')
  const preset = field(container, 'Provider')
  await fill(key, 'synthetic-pending-key')
  await click(container, 'Save')
  assert.equal(saved.mock.callCount(), 1)
  assert.equal(selected.mock.callCount(), 0)
  const formFields = container.querySelector('form > fieldset')
  assert.equal(formFields.disabled, true)
  assert.equal(formFields.contains(key), true)
  assert.equal(formFields.contains(preset), true)
  assert.equal(key.matches(':disabled'), true)
  assert.equal(preset.matches(':disabled'), true)
  const edit = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Edit',
  )
  assert.equal(edit.disabled, true)
  await act(async () => edit.click())
  assert.equal(field(container, 'Name').value, 'DeepSeek')
  assert.equal(preset.value, 'deepseek')
  await act(async () => finishSave(deepseekProvider))
  assert.equal(formFields.disabled, false)
  assert.match(
    container.querySelector('[role="alert"]').textContent,
    /Default selection failed/,
  )
  assert.equal(field(container, 'Name').value, 'DeepSeek')
  assert.equal(
    field(container, 'API base URL').value,
    'https://api.deepseek.com',
  )
  assert.equal(field(container, 'Model ID').value, 'deepseek-flash')
  assert.equal(key.value, '')
  await click(container, 'Save')
  assert.deepEqual(saved.mock.calls[1].arguments, [
    deepseekProvider.providerId,
    deepseekDraft,
  ])
  assert.deepEqual(selected.mock.calls[1].arguments, [
    { providerId: deepseekProvider.providerId, modelId: 'deepseek-flash' },
  ])
  assert.equal(container.querySelector('form'), null)
})

test('editing a configured provider never reveals or resubmits its stored key', async (t) => {
  mockModels(t)
  const saved = t.mock.method(modelsApi, 'save', async () => provider)
  const container = await mount(t, ModelsPanel)
  await click(container, 'Edit')
  const key = container.querySelector('input[type="password"]')
  assert.equal(key.value, '')
  assert.equal(key.required, false)
  assert.match(key.placeholder, /never returned/)
  assert.equal(field(container, 'Name').value, provider.name)
  assert.equal(field(container, 'API base URL').value, provider.baseUrl)
  assert.equal(field(container, 'Model ID').value, 'model-one')
  assert.equal(container.querySelectorAll('select').length, 1)
  assert.doesNotMatch(
    container.querySelector('form').textContent,
    /Set as default model/,
  )
  await click(container, 'Save')
  const [providerId, payload] = saved.mock.calls[0].arguments
  assert.equal(providerId, provider.providerId)
  assert.equal('apiKey' in payload, false)
  assert.equal('clearApiKey' in payload, false)
  assert.equal(payload.models[0].modelId, 'model-one')
  assert.equal(container.querySelector('input[type="password"]'), null)
})

test('a replacement key is sent once then removed from the editor; default selection uses stable provider and model ids', async (t) => {
  mockModels(t)
  const saved = t.mock.method(modelsApi, 'save', async () => provider)
  const selected = t.mock.method(modelsApi, 'setDefault', async () => ({}))
  const container = await mount(t, ModelsPanel)
  await click(container, 'Edit')
  await fill(
    container.querySelector('input[type="password"]'),
    'synthetic-test-only',
  )
  await click(container, 'Save')
  assert.equal(saved.mock.calls[0].arguments[1].apiKey, 'synthetic-test-only')
  assert.equal(container.textContent.includes('synthetic-test-only'), false)
  await click(container, 'Set default')
  assert.deepEqual(selected.mock.calls[0].arguments, [
    { providerId: 'platform-provider', modelId: 'model-one' },
  ])
})

test('personal models use their own endpoints and stable defaults without reading existing keys', async (t) => {
  saveStoredSession({
    userId: 'personal-owner',
    accessToken: 'synthetic-key',
    role: 'member',
    roles: ['member'],
    authzVersion: 1,
    permissions: ['models.personal.manage'],
  })
  const personal = { ...provider, providerId: 'owned-personal-provider' }
  t.mock.method(personalModelsApi, 'providers', async () => ({
    providers: [personal],
  }))
  t.mock.method(personalModelsApi, 'defaultSelection', async () => ({
    selection: null,
  }))
  const global = t.mock.method(modelsApi, 'providers', async () => {
    throw new Error(
      'Personal model page must not access platform administration',
    )
  })
  const saved = t.mock.method(personalModelsApi, 'save', async () => personal)
  const verify = t.mock.method(personalModelsApi, 'verify', async () => ({
    ok: true,
  }))
  const selected = t.mock.method(
    personalModelsApi,
    'setDefault',
    async () => ({}),
  )
  const container = await mount(t, () => h(ModelsPanel, { scope: 'personal' }))
  assert.match(container.textContent, /Personal default model/)
  await click(container, 'Verify connection')
  assert.deepEqual(verify.mock.calls[0].arguments, ['owned-personal-provider'])
  await click(container, 'Edit')
  assert.equal(container.querySelector('input[type="password"]').value, '')
  await click(container, 'Save')
  assert.equal(saved.mock.calls[0].arguments[0], 'owned-personal-provider')
  assert.equal('apiKey' in saved.mock.calls[0].arguments[1], false)
  await click(container, 'Set default')
  assert.deepEqual(selected.mock.calls[0].arguments, [
    { providerId: 'owned-personal-provider', modelId: 'model-one' },
  ])
  assert.equal(global.mock.callCount(), 0)
})

test('account changes discard an unsaved key and stale provider editor before new-account data arrives', async (t) => {
  const session = (userId) => ({
    userId,
    accessToken: 'synthetic-token',
    role: 'member',
    roles: ['member'],
    authzVersion: 1,
    permissions: ['models.personal.manage'],
  })
  saveStoredSession(session('first-user'))
  let resolve
  const pending = new Promise((finish) => {
    resolve = finish
  })
  let requests = 0
  t.mock.method(personalModelsApi, 'providers', () =>
    ++requests === 1 ? Promise.resolve({ providers: [provider] }) : pending,
  )
  t.mock.method(personalModelsApi, 'defaultSelection', async () => ({
    selection: null,
  }))
  const container = await mount(t, () => h(ModelsPanel, { scope: 'personal' }))
  await click(container, 'Edit')
  await fill(
    container.querySelector('input[type="password"]'),
    'unsaved-fixture-key',
  )
  await act(async () => saveStoredSession(session('second-user')))
  assert.equal(container.querySelector('input[type="password"]'), null)
  assert.doesNotMatch(
    container.textContent,
    /Platform model|unsaved-fixture-key/,
  )
  await act(async () => resolve({ providers: [] }))
  await click(container, 'Add provider')
  assert.equal(container.querySelector('input[type="password"]').value, '')
  assert.equal(
    container.querySelector('input[type="url"]').value,
    'https://api.deepseek.com',
  )
})

test('model-use permission alone never loads personal keys or displays management actions', async (t) => {
  saveStoredSession({
    userId: 'use-only',
    accessToken: 'synthetic-key',
    role: 'custom',
    roles: ['use-models'],
    authzVersion: 1,
    permissions: ['models.use'],
  })
  const read = t.mock.method(personalModelsApi, 'providers', async () => {
    throw new Error('Personal management must stay hidden')
  })
  const container = await mount(t, () => h(ModelsPanel, { scope: 'personal' }))
  assert.match(container.textContent, /cannot manage personal models/)
  assert.equal(container.querySelector('input'), null)
  assert.equal(container.querySelector('button'), null)
  assert.equal(read.mock.callCount(), 0)
})

test('admin permissions are view-only while member and custom roles remain editable', async (t) => {
  t.mock.method(managementApi, 'roles', async () => ({
    roles: [
      {
        id: 'admin',
        name: 'Administrator',
        builtin: true,
        description: '',
        permissions: ['users.manage'],
      },
      {
        id: 'member',
        name: 'Member',
        builtin: true,
        description: '',
        permissions: [],
      },
    ],
    permissions: [{ id: 'users.manage', label: 'Manage users' }],
  }))
  const saved = t.mock.method(managementApi, 'saveRole', async () => ({}))
  const container = await mount(t, RolesPanel)
  await click(container, 'View permissions')
  assert.equal(container.querySelector('input[type="checkbox"]').disabled, true)
  await click(container, 'Close')
  await click(container, 'Edit')
  const checkbox = container.querySelector('input[type="checkbox"]')
  assert.equal(checkbox.disabled, false)
  await act(async () => checkbox.click())
  await click(container, 'Save permissions')
  assert.deepEqual(saved.mock.calls[0].arguments, [
    'member',
    { name: 'Member', description: '', permissions: ['users.manage'] },
  ])
})
