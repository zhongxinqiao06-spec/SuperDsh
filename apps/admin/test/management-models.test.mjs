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
  'HTMLButtonElement',
  'HTMLSelectElement',
  'Element',
  'Node',
  'NodeFilter',
  'MutationObserver',
  'CustomEvent',
  'getComputedStyle',
])
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: dom.window[key],
  })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act, useState } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const hooks = registerSource()
const { ModelsPanel } =
  await import('../src/components/management/models-panel.tsx')
const { RolesPanel } =
  await import('../src/components/management/roles-panel.tsx')
const { UsersPanel } =
  await import('../src/components/management/users-panel.tsx')
const { AuthProvider } = await import('../src/components/auth/auth-context.tsx')
const { authApi } = await import('../src/features/auth/api.ts')
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
  return document.body
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
  assert.match(
    container.querySelector('[role="dialog"]').textContent,
    /Edit provider/,
  )
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
  assert.equal(
    container.querySelector('form').querySelectorAll('select').length,
    1,
  )
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

test('all built-in roles are view-only while custom roles remain editable', async (t) => {
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
      {
        id: 'role_custom',
        name: 'Custom',
        builtin: false,
        description: '',
        permissions: [],
      },
    ],
    permissions: [{ id: 'users.manage', label: 'Manage users' }],
  }))
  const saved = t.mock.method(managementApi, 'saveRole', async () => ({}))
  const container = await mount(t, RolesPanel)
  for (const name of ['Administrator', 'Member']) {
    const heading = [...container.querySelectorAll('h2')].find(
      (item) => item.textContent === name,
    )
    const card = heading.parentElement.parentElement
    assert.equal(card.querySelectorAll('button').length, 1)
    await click(card, 'View permissions')
    const form = container.querySelector('form')
    assert.ok(
      [...form.querySelectorAll('input')].every((input) => input.disabled),
    )
    assert.equal(form.querySelector('button[type="submit"]'), null)
    await act(async () =>
      form.dispatchEvent(
        new window.Event('submit', { bubbles: true, cancelable: true }),
      ),
    )
    assert.equal(saved.mock.callCount(), 0)
    await click(container, 'Close')
  }
  await click(container, 'Edit')
  const checkbox = container.querySelector('input[type="checkbox"]')
  assert.equal(checkbox.disabled, false)
  await act(async () => checkbox.click())
  await click(container, 'Save permissions')
  assert.deepEqual(saved.mock.calls[0].arguments, [
    'role_custom',
    { name: 'Custom', description: '', permissions: ['users.manage'] },
  ])
  await click(container, 'Create role')
  await fill(field(container, 'Role name'), 'New custom role')
  await click(container, 'Save permissions')
  assert.deepEqual(saved.mock.calls[1].arguments, [
    null,
    { name: 'New custom role', description: '', permissions: [] },
  ])
})

test('provider removal requires dialog confirmation and failed removal stays recoverable', async (t) => {
  mockModels(t)
  const remove = t.mock.method(modelsApi, 'remove', async () => {
    throw new Error('Provider is unavailable')
  })
  const container = await mount(t, ModelsPanel)
  await click(container, 'Delete')
  const dialog = container.querySelector('[role="dialog"]')
  assert.match(dialog.textContent, /Delete provider/)
  assert.equal(remove.mock.callCount(), 0)
  await click(dialog, 'Cancel')
  assert.equal(container.querySelector('[role="dialog"]'), null)
  assert.equal(remove.mock.callCount(), 0)
  await click(container, 'Delete')
  await click(container.querySelector('[role="dialog"]'), 'Confirm delete')
  assert.equal(remove.mock.callCount(), 1)
  assert.match(
    container.querySelector('[role="dialog"] [role="alert"]').textContent,
    /Provider is unavailable/,
  )
})

test('provider cards and model catalogs paginate without truncating the edit draft', async (t) => {
  const models = Array.from({ length: 31 }, (_, index) => ({
    modelId: `model-${index + 1}`,
    name: `Model ${index + 1}`,
    inputTypes: ['text'],
  }))
  const providers = Array.from({ length: 26 }, (_, index) => ({
    ...provider,
    providerId: `provider-${index + 1}`,
    name: `Provider ${index + 1}`,
    models: index === 0 ? models : [provider.models[0]],
  }))
  t.mock.method(modelsApi, 'providers', async () => ({ providers }))
  t.mock.method(modelsApi, 'defaultSelection', async () => ({
    selection: null,
  }))
  const save = t.mock.method(modelsApi, 'save', async () => providers[0])
  const container = await mount(t, ModelsPanel)
  assert.equal(container.querySelectorAll('section').length, 25)
  const first = container.querySelector('section')
  assert.equal(first.querySelectorAll('tbody tr').length, 25)
  await click(first, 'Next')
  assert.equal(first.querySelectorAll('tbody tr').length, 6)
  assert.match(first.querySelector('tbody').textContent, /Model 31/)
  await click(first, 'Edit')
  assert.equal(
    container.querySelectorAll('[role="dialog"] input[required]').length,
    27,
  )
  await click(container.querySelector('[role="dialog"]'), 'Next')
  assert.equal(
    field(container.querySelector('[role="dialog"]'), 'Model ID').value,
    'model-26',
  )
  await click(container.querySelector('[role="dialog"]'), 'Add model')
  assert.equal(
    field(container.querySelector('[role="dialog"]'), 'Model ID', 6).value,
    '',
  )
  await fill(
    field(container.querySelector('[role="dialog"]'), 'Model ID', 6),
    'model-32',
  )
  await click(container.querySelector('[role="dialog"]'), 'Save')
  assert.equal(save.mock.calls[0].arguments[1].models.length, 32)
  assert.equal(save.mock.calls[0].arguments[1].models[31].modelId, 'model-32')
  const providerPagination = [...container.querySelectorAll('nav')].at(-1)
  await click(providerPagination, 'Next')
  assert.equal(container.querySelectorAll('section').length, 1)
  assert.match(container.querySelector('section').textContent, /Provider 26/)
  await fill(
    container.querySelector('input[aria-label="Search providers or models"]'),
    'Provider 1',
  )
  assert.equal(container.querySelectorAll('section').length, 11)
  assert.match(
    [...container.querySelectorAll('nav')].at(-1).textContent,
    /Page 1 \/ 1/,
  )
})

test('role cards paginate and a failed edit keeps its values inside the dialog', async (t) => {
  const roles = Array.from({ length: 26 }, (_, index) => ({
    id: `role-${index + 1}`,
    name: `Role ${index + 1}`,
    description: 'Description',
    builtin: false,
    permissions: [],
  }))
  t.mock.method(managementApi, 'roles', async () => ({
    roles,
    permissions: [],
  }))
  const save = t.mock.method(managementApi, 'saveRole', async () => {
    throw new Error('Role save failed')
  })
  const remove = t.mock.method(managementApi, 'deleteRole', async () => ({}))
  const container = await mount(t, RolesPanel)
  assert.equal(container.querySelectorAll('h2').length, 25)
  await click(container, 'Next')
  assert.equal(container.querySelectorAll('h2').length, 1)
  assert.equal(container.querySelector('h2').textContent, 'Role 26')
  await click(container, 'Edit')
  await fill(field(container, 'Role name'), 'Updated role')
  await click(container, 'Save permissions')
  assert.equal(save.mock.callCount(), 1)
  assert.equal(field(container, 'Role name').value, 'Updated role')
  assert.match(
    container.querySelector('[role="dialog"] [role="alert"]').textContent,
    /Role save failed/,
  )
  await click(container.querySelector('[role="dialog"]'), 'Close')
  await click(container, 'Delete')
  assert.equal(remove.mock.callCount(), 0)
  await click(container.querySelector('[role="dialog"]'), 'Cancel')
  assert.equal(remove.mock.callCount(), 0)
  await fill(
    container.querySelector('input[aria-label="Search roles"]'),
    'Role 1',
  )
  assert.equal(container.querySelectorAll('h2').length, 11)
  assert.match(container.querySelector('nav').textContent, /Page 1 \/ 1/)
})

test('users use server pagination and dialog mutations preserve failures and require confirmation', async (t) => {
  const account = {
    userId: 'admin-owner',
    role: 'admin',
    roles: ['admin'],
    permissions: ['users.read', 'users.manage', 'roles.manage'],
    authzVersion: 1,
  }
  saveStoredSession({ ...account, accessToken: 'synthetic-user-test' })
  t.mock.method(authApi, 'config', async () => ({
    needsBootstrap: false,
    registrationOpen: true,
  }))
  t.mock.method(authApi, 'me', async () => account)
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected network request')
  })
  const member = {
    userId: 'member-id',
    username: 'member',
    displayName: 'Member',
    email: null,
    role: 'member',
    roles: ['member'],
    disabled: false,
    deletedAt: null,
  }
  const users = t.mock.method(
    managementApi,
    'users',
    async (page, search, pageSize) => ({
      users: [member],
      page,
      pageSize,
      total: search ? 1 : 51,
    }),
  )
  t.mock.method(managementApi, 'roles', async () => ({
    roles: [{ id: 'member', name: 'Member' }],
    permissions: [],
  }))
  const create = t.mock.method(managementApi, 'createUser', async () => {
    throw new Error('Username already exists')
  })
  const remove = t.mock.method(managementApi, 'deleteUser', async () => ({}))
  const update = t.mock.method(managementApi, 'updateUser', async () => ({}))
  const container = await mount(t, () => h(AuthProvider, null, h(UsersPanel)))
  assert.deepEqual(users.mock.calls[0].arguments, [1, '', 25])
  await click(container, 'Next')
  assert.deepEqual(users.mock.calls.at(-1).arguments, [2, '', 25])
  await select(container.querySelector('nav select'), '10')
  assert.deepEqual(users.mock.calls.at(-1).arguments, [1, '', 10])
  await fill(
    container.querySelector('input[aria-label="Search users"]'),
    'member',
  )
  await click(container, 'Search')
  assert.deepEqual(users.mock.calls.at(-1).arguments, [1, 'member', 10])
  await click(container, 'Create user')
  let dialog = container.querySelector('[role="dialog"]')
  await fill(field(dialog, 'Username'), 'new-user')
  await fill(field(dialog, 'Display name'), 'New user')
  await fill(field(dialog, 'Initial password'), 'synthetic-test-password')
  await click(dialog, 'Save')
  assert.equal(create.mock.callCount(), 1)
  assert.match(
    dialog.querySelector('[role="alert"]').textContent,
    /Username already exists/,
  )
  assert.equal(field(dialog, 'Username').value, 'new-user')
  await click(dialog, 'Cancel')
  assert.equal(container.querySelector('input[type="password"]'), null)
  await click(container, 'Disable')
  dialog = container.querySelector('[role="dialog"]')
  assert.equal(update.mock.callCount(), 0)
  await click(dialog, 'Cancel')
  assert.equal(update.mock.callCount(), 0)
  await click(container, 'Delete')
  dialog = container.querySelector('[role="dialog"]')
  assert.equal(remove.mock.callCount(), 0)
  await click(dialog, 'Confirm')
  assert.deepEqual(remove.mock.calls[0].arguments, ['member-id'])
  assert.equal(container.querySelector('[role="dialog"]'), null)
})

for (const transition of [
  'account-change',
  'same-user-relogin',
  'leave-page',
  'token-refresh',
]) {
  test(`delayed provider saves respect the ${transition} lifecycle transition`, async (t) => {
    const session = (userId, accessToken = 'synthetic-before') => ({
      userId,
      accessToken,
      role: 'member',
      roles: ['member'],
      authzVersion: 1,
      permissions: ['models.personal.manage'],
    })
    saveStoredSession(session('first-owner'))
    t.mock.method(personalModelsApi, 'providers', async () => ({
      providers: [],
    }))
    t.mock.method(personalModelsApi, 'defaultSelection', async () => ({
      selection: null,
    }))
    let finishSave
    const save = t.mock.method(
      personalModelsApi,
      'save',
      () =>
        new Promise((resolve) => {
          finishSave = resolve
        }),
    )
    const setDefault = t.mock.method(
      personalModelsApi,
      'setDefault',
      async () => ({}),
    )
    let leavePage
    function Page() {
      const [visible, setVisible] = useState(true)
      leavePage = () => setVisible(false)
      return visible
        ? h(ModelsPanel, { scope: 'personal' })
        : h('p', null, 'Another module')
    }
    const container = await mount(t, Page)
    await click(container, 'Add provider')
    await fill(
      container.querySelector('input[type="password"]'),
      'synthetic-delayed-key',
    )
    await click(container.querySelector('[role="dialog"]'), 'Save')
    assert.equal(save.mock.callCount(), 1)
    assert.equal(setDefault.mock.callCount(), 0)
    await act(async () => {
      if (transition === 'account-change')
        saveStoredSession(session('second-owner'))
      if (transition === 'same-user-relogin') {
        clearStoredSession()
        saveStoredSession(session('first-owner', 'synthetic-new-login'))
      }
      if (transition === 'leave-page') leavePage()
      if (transition === 'token-refresh')
        saveStoredSession(session('first-owner', 'synthetic-refreshed-token'))
    })
    await act(async () => finishSave(deepseekProvider))
    assert.equal(
      setDefault.mock.callCount(),
      transition === 'token-refresh' ? 1 : 0,
    )
    if (transition === 'account-change' || transition === 'leave-page')
      assert.equal(container.querySelector('[role="dialog"]'), null)
  })
}

test('provider submission validates every model page and locates the first invalid row without losing the draft', async (t) => {
  const models = Array.from({ length: 31 }, (_, index) => ({
    modelId: `model-${index + 1}`,
    name: `Model ${index + 1}`,
    inputTypes: ['text'],
  }))
  const catalog = { ...provider, models }
  t.mock.method(modelsApi, 'providers', async () => ({ providers: [catalog] }))
  t.mock.method(modelsApi, 'defaultSelection', async () => ({
    selection: null,
  }))
  const save = t.mock.method(modelsApi, 'save', async () => catalog)
  const container = await mount(t, ModelsPanel)
  await click(container, 'Edit')
  const editor = container.querySelector('[role="dialog"]')
  await fill(field(editor, 'Model ID'), '  ')
  await click(editor, 'Next')
  await click(editor, 'Save')
  assert.equal(save.mock.callCount(), 0)
  assert.match(
    editor.querySelector('[role="alert"]').textContent,
    /Model 1: Model ID is required/,
  )
  assert.match(editor.querySelector('nav').textContent, /Page 1 \/ 2/)
  assert.equal(field(editor, 'Model ID').value, '  ')
  await fill(field(editor, 'Model ID'), 'model-1')
  await click(editor, 'Next')
  await fill(field(editor, 'Model ID'), ' model-1 ')
  await click(editor, 'Previous')
  await click(editor, 'Save')
  assert.equal(save.mock.callCount(), 0)
  assert.match(
    editor.querySelector('[role="alert"]').textContent,
    /Model 26: Model ID model-1 is duplicated/,
  )
  assert.match(editor.querySelector('nav').textContent, /Page 2 \/ 2/)
  assert.equal(field(editor, 'Model ID').value, ' model-1 ')
  await fill(field(editor, 'Model ID'), ' model-26 ')
  await fill(field(editor, 'Max output tokens (optional)'), '1.5')
  await click(editor, 'Previous')
  await click(editor, 'Save')
  assert.equal(save.mock.callCount(), 0)
  assert.match(
    editor.querySelector('[role="alert"]').textContent,
    /Model 26: Max output tokens must be a positive integer/,
  )
  await fill(field(editor, 'Max output tokens (optional)'), '128')
  await fill(field(editor, 'Context window (optional)', 1), '0')
  await click(editor, 'Previous')
  await click(editor, 'Save')
  assert.equal(save.mock.callCount(), 0)
  assert.match(
    editor.querySelector('[role="alert"]').textContent,
    /Model 27: Context window must be a positive integer/,
  )
  await fill(field(editor, 'Context window (optional)', 1), '1024')
  await click(editor, 'Save')
  assert.equal(save.mock.callCount(), 1)
  const submitted = save.mock.calls[0].arguments[1].models
  assert.equal(submitted.length, 31)
  assert.equal(submitted[25].modelId, 'model-26')
  assert.equal(submitted[25].maxTokens, 128)
  assert.equal(submitted[26].contextWindow, 1024)
})
