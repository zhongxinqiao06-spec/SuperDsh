import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { JSDOM } from 'jsdom'
import { registerSource } from './helpers/onboarding-source.mjs'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://console.example.test/',
  pretendToBeVisual: true,
})
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLButtonElement',
  'HTMLFormElement',
  'HTMLSelectElement',
  'Element',
  'Node',
  'NodeFilter',
  'Event',
  'CustomEvent',
  'MutationObserver',
  'getComputedStyle',
])
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: dom.window[key],
  })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
const { createElement: h, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const source = registerSource()
const mocks = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/components/auth/auth-context.tsx'))
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export const useAuth = () => globalThis.consoleAuth',
      }
    if (url.endsWith('/components/workspace-context.tsx'))
      throw new Error('Console pages must not load the chat workspace')
    return nextLoad(url, context)
  },
})
const { MenusPage } = await import('../src/components/console/menus-page.tsx')
const { OverviewPage } =
  await import('../src/components/console/overview-page.tsx')
const { PageHeader } = await import('../src/components/pages/page-header.tsx')
const { consoleApi, NAVIGATION_CHANGED_EVENT } =
  await import('../src/features/console/api.ts')
const { apiClient, ApiError } = await import('../src/lib/api/index.ts')
const { saveStoredSession, clearStoredSession } =
  await import('../src/features/auth/session.ts')
mocks.deregister()
source.deregister()

const data = {
  version: 4,
  items: [
    {
      id: 'overview',
      kind: 'page',
      moduleId: 'overview',
      parentId: null,
      title: 'Overview',
      icon: 'gauge',
      order: 0,
      visible: true,
      roleIds: [],
    },
    {
      id: 'access',
      kind: 'group',
      moduleId: null,
      parentId: null,
      title: 'Access',
      icon: 'users',
      order: 10,
      visible: true,
      roleIds: [],
    },
    {
      id: 'access.users',
      kind: 'page',
      moduleId: 'access.users',
      parentId: 'access',
      title: 'Users',
      icon: 'users',
      order: 0,
      visible: true,
      roleIds: [],
    },
    {
      id: 'access.menus',
      kind: 'page',
      moduleId: 'access.menus',
      parentId: 'access',
      title: 'Menus',
      icon: 'menu',
      order: 10,
      visible: true,
      roleIds: [],
    },
  ],
  modules: [
    {
      id: 'overview',
      route: '#/overview',
      title: 'Overview',
      icon: 'gauge',
      permissions: [],
    },
    {
      id: 'access.users',
      route: '#/access/users',
      title: 'Users',
      icon: 'users',
      permissions: ['users.read'],
    },
    {
      id: 'access.menus',
      route: '#/access/menus',
      title: 'Menus',
      icon: 'menu',
      permissions: ['menus.read', 'menus.manage'],
    },
  ],
  icons: ['gauge', 'users', 'menu', 'folder'],
  roles: [
    { id: 'admin', name: 'Administrator' },
    { id: 'member', name: 'Member' },
  ],
}
const permissions = ['menus.read', 'menus.manage', 'users.read']
async function mount(
  t,
  component = MenusPage,
  allowed = permissions,
  props = {},
  dataset = data,
) {
  const account = {
    userId: 'menu-fixture',
    accessToken: 'fixture-token',
    authzVersion: 1,
    role: 'member',
    roles: ['member'],
    displayName: 'Fixture',
    username: 'fixture',
    permissions: allowed,
  }
  globalThis.consoleAuth = {
    session: account,
    me: account,
    can: (permission) => allowed.includes(permission),
  }
  saveStoredSession(account)
  const oldGet = apiClient.get
  const oldPut = apiClient.put
  const oldPost = apiClient.post
  apiClient.get = async (path) => {
    assert.equal(path, '/admin/menus')
    return structuredClone(dataset)
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () =>
    root.render(
      h(
        NextIntlClientProvider,
        { locale: 'en', messages: {} },
        h(component, props),
      ),
    ),
  )
  t.after(async () => {
    await act(async () => root.unmount())
    container.remove()
    clearStoredSession()
    apiClient.get = oldGet
    apiClient.put = oldPut
    apiClient.post = oldPost
  })
  return document.body
}
function persistedMenu(items, version = 5, base = data) {
  const next = {
    ...structuredClone(base),
    version,
    items: structuredClone(items),
  }
  apiClient.get = async (path) => {
    assert.equal(path, '/admin/menus')
    return structuredClone(next)
  }
  return next
}
function dialog(container) {
  const current = container.querySelector('[role="dialog"]')
  assert.ok(current, 'Expected an open menu dialog')
  return current
}
function row(container, title) {
  const found = [...container.querySelectorAll('tbody tr')].find(
    (item) => item.querySelector('button')?.textContent.trim() === title,
  )
  assert.ok(found, `Missing menu row ${title}`)
  return found
}
function button(container, text) {
  const found = [...container.querySelectorAll('button')].find(
    (button) => button.textContent.trim() === text,
  )
  assert.ok(found, `Missing button ${text}`)
  return found
}
async function click(container, text) {
  const target = button(container, text)
  assert.notEqual(target.disabled, true)
  await act(async () => target.click())
}
function field(container, title) {
  const label = [...container.querySelectorAll('label')].find((label) =>
    [...label.childNodes].some(
      (node) =>
        node.nodeType === Node.TEXT_NODE && node.textContent.trim() === title,
    ),
  )
  assert.ok(label, `Missing field ${title}`)
  return label.querySelector('input, select')
}
async function fill(input, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      input instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype,
      'value',
    ).set.call(input, value)
    input.dispatchEvent(
      new Event(input instanceof HTMLSelectElement ? 'change' : 'input', {
        bubbles: true,
      }),
    )
  })
}

test('console menu editor saves label, group, icon, order and role visibility without changing module identity', async (t) => {
  const container = await mount(t)
  let saved
  let notifications = 0
  const changed = () => notifications++
  window.addEventListener(NAVIGATION_CHANGED_EVENT, changed)
  t.after(() => window.removeEventListener(NAVIGATION_CHANGED_EVENT, changed))
  apiClient.put = async (path, payload) => {
    assert.equal(path, '/admin/menus')
    saved = payload
    return persistedMenu(payload.items)
  }
  await click(container, 'Users')
  await fill(field(container, 'Name'), '  User accounts  ')
  assert.equal(field(container, 'Name').maxLength, 64)
  await fill(field(container, 'Icon'), 'folder')
  await fill(field(container, 'Parent group'), '')
  await fill(field(container, 'Order'), '25')
  const member = [...container.querySelectorAll('label')]
    .find((label) => label.textContent === 'Member')
    .querySelector('input')
  await act(async () => member.click())
  await act(async () => container.querySelector('[role="switch"]').click())
  assert.equal(container.querySelector('input[name="route"]'), null)
  assert.equal(
    [...container.querySelectorAll('button')].some((item) =>
      item.textContent.includes('Delete page'),
    ),
    false,
  )
  await click(container, 'Save menu')
  assert.equal(saved.version, 4)
  assert.deepEqual(
    saved.items.find((item) => item.id === 'access.users'),
    {
      ...data.items[2],
      title: 'User accounts',
      icon: 'folder',
      parentId: null,
      order: 25,
      roleIds: ['member'],
      visible: false,
    },
  )
  assert.equal(notifications, 1)
  assert.equal(container.querySelector('[role="dialog"]'), null)
  assert.match(row(container, 'User accounts').textContent, /Hidden/)
})

test('group creation and deletion preserve all registered pages', async (t) => {
  const uuidDescriptor = Object.getOwnPropertyDescriptor(
    globalThis.crypto,
    'randomUUID',
  )
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    configurable: true,
    value: undefined,
  })
  t.after(() => {
    if (uuidDescriptor)
      Object.defineProperty(globalThis.crypto, 'randomUUID', uuidDescriptor)
    else delete globalThis.crypto.randomUUID
  })
  const container = await mount(t)
  let saved
  let writes = 0
  apiClient.put = async (_path, payload) => {
    saved = payload
    return persistedMenu(payload.items, 4 + ++writes)
  }
  await click(container, 'Add group')
  await fill(field(container, 'Name'), 'Operations')
  await click(container, 'Save menu')
  assert.equal(writes, 1)
  assert.ok(row(container, 'Operations'))
  await click(row(container, 'Access'), 'Delete')
  assert.equal(writes, 1)
  await click(dialog(container), 'Cancel')
  assert.equal(writes, 1)
  assert.ok(row(container, 'Access'))
  await click(row(container, 'Access'), 'Delete')
  await click(dialog(container), 'Confirm')
  assert.equal(writes, 2)
  assert.equal(saved.version, 5)
  assert.ok(
    saved.items.find(
      (item) => item.title === 'Operations' && item.kind === 'group',
    ),
  )
  assert.equal(
    saved.items.some((item) => item.id === 'access'),
    false,
  )
  assert.deepEqual(
    saved.items.filter((item) => item.kind === 'page').map((item) => item.id),
    data.items.filter((item) => item.kind === 'page').map((item) => item.id),
  )
  assert.ok(
    saved.items
      .filter((item) => item.kind === 'page')
      .every((item) => item.parentId === null),
  )
})

test('menus.read allows viewing but does not allow mutations even with forced form submit', async (t) => {
  const container = await mount(t, MenusPage, ['menus.read'])
  let writes = 0
  apiClient.put = async () => {
    writes++
    return data
  }
  assert.equal(button(container, 'Add group').disabled, true)
  assert.equal(button(container, 'Restore defaults').disabled, true)
  await click(container, 'Overview')
  assert.equal(button(dialog(container), 'Save menu').disabled, true)
  assert.equal(container.querySelector('fieldset').disabled, true)
  await act(async () =>
    container
      .querySelector('form')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )
  assert.equal(writes, 0)
})

test('menu managers cannot edit pages or parent groups outside their own permissions', async (t) => {
  const container = await mount(t, MenusPage, ['menus.read', 'menus.manage'])
  await click(container, 'Users')
  assert.equal(container.querySelector('fieldset').disabled, true)
  await click(dialog(container), 'Cancel')
  await click(container, 'Access')
  assert.equal(container.querySelector('fieldset').disabled, true)
  await click(dialog(container), 'Cancel')
  await click(container, 'Overview')
  assert.equal(container.querySelector('fieldset').disabled, false)
})

test('concurrent edits require reloading latest server configuration before saving', async (t) => {
  const container = await mount(t)
  apiClient.put = async () => {
    throw new ApiError({
      status: 409,
      detail: 'version conflict',
      kind: 'http',
    })
  }
  await click(container, 'Overview')
  await fill(field(container, 'Name'), 'Changed')
  await click(container, 'Save menu')
  assert.match(container.textContent, /Another administrator changed the menu/)
  assert.equal(button(container, 'Save menu').disabled, true)
  assert.equal(field(dialog(container), 'Name').value, 'Changed')
  apiClient.get = async () => ({ ...data, version: 6 })
  await click(dialog(container), 'Reload latest configuration')
  assert.equal(container.querySelector('[role="dialog"]'), null)
  assert.match(container.textContent, /Version 6/)
  await click(container, 'Overview')
  assert.equal(field(dialog(container), 'Name').value, 'Overview')
})

test('restore defaults carries the current version and notifies navigation', async (t) => {
  const container = await mount(t)
  let request
  apiClient.post = async (path, body) => {
    request = { path, body }
    return data
  }
  await click(container, 'Restore defaults')
  assert.equal(request, undefined)
  await click(dialog(container), 'Confirm')
  assert.deepEqual(request, {
    path: '/admin/menus/reset',
    body: { version: 4 },
  })
})

test('deleted role restrictions remain visible until explicitly removed', async (t) => {
  const dataset = structuredClone(data)
  dataset.items[0].roleIds = ['deleted-role']
  const container = await mount(t, MenusPage, permissions, {}, dataset)
  await click(container, 'Overview')
  const checkbox = [...dialog(container).querySelectorAll('label')]
    .find((label) => label.textContent === 'Deleted role (deleted-role)')
    .querySelector('input')
  assert.equal(checkbox.checked, true)
  let saved
  let version = dataset.version
  apiClient.put = async (_path, payload) => {
    saved = payload
    return persistedMenu(payload.items, ++version, dataset)
  }
  await fill(field(container, 'Name'), 'Overview renamed')
  await click(container, 'Save menu')
  assert.deepEqual(saved.items[0].roleIds, ['deleted-role'])
  await click(container, 'Overview renamed')
  const retainedCheckbox = [...dialog(container).querySelectorAll('label')]
    .find((label) => label.textContent === 'Deleted role (deleted-role)')
    .querySelector('input')
  assert.equal(retainedCheckbox.checked, true)
  await act(async () => retainedCheckbox.click())
  await click(container, 'Save menu')
  assert.deepEqual(saved.items[0].roleIds, [])
})

test('cancelling menu and group editors keeps persisted configuration unchanged', async (t) => {
  const container = await mount(t)
  let writes = 0
  apiClient.put = async () => {
    writes++
    return data
  }
  await click(container, 'Users')
  await fill(field(dialog(container), 'Name'), 'Unsaved users title')
  await click(dialog(container), 'Cancel')
  assert.equal(writes, 0)
  assert.ok(row(container, 'Users'))
  assert.doesNotMatch(
    container.querySelector('tbody').textContent,
    /Unsaved users title/,
  )
  await click(container, 'Add group')
  await fill(field(dialog(container), 'Name'), 'Unsaved group')
  await click(dialog(container), 'Cancel')
  assert.equal(writes, 0)
  assert.equal(container.querySelectorAll('tbody tr').length, data.items.length)
  await click(container, 'Users')
  assert.equal(field(dialog(container), 'Name').value, 'Users')
})

test('failed group creation preserves its dialog draft for retry without duplicate insertion', async (t) => {
  const container = await mount(t)
  const requests = []
  apiClient.put = async (_path, payload) => {
    requests.push(structuredClone(payload))
    if (requests.length === 1) throw new Error('Navigation storage unavailable')
    return persistedMenu(payload.items)
  }
  await click(container, 'Add group')
  await fill(field(dialog(container), 'Name'), 'Retry group')
  await click(dialog(container), 'Save menu')
  assert.equal(requests.length, 1)
  assert.match(
    dialog(container).querySelector('[role="alert"]').textContent,
    /Navigation storage unavailable/,
  )
  assert.equal(field(dialog(container), 'Name').value, 'Retry group')
  assert.equal(container.querySelectorAll('tbody tr').length, data.items.length)
  await click(dialog(container), 'Save menu')
  assert.equal(requests.length, 2)
  assert.deepEqual(requests[1], requests[0])
  assert.equal(container.querySelector('[role="dialog"]'), null)
  assert.ok(row(container, 'Retry group'))
  assert.equal(
    container.querySelectorAll('tbody tr').length,
    data.items.length + 1,
  )
})

test('menu rows paginate and changing or clearing search resets to the first page', async (t) => {
  const dataset = structuredClone(data)
  dataset.items.push(
    ...Array.from({ length: 30 }, (_, index) => ({
      id: `group-${index + 1}`,
      kind: 'group',
      moduleId: null,
      parentId: null,
      title: `Operations ${index + 1}`,
      icon: 'folder',
      order: 20 + index,
      visible: true,
      roleIds: [],
    })),
  )
  const container = await mount(t, MenusPage, permissions, {}, dataset)
  const pagination = container.querySelector(
    'nav[aria-label="List pagination"]',
  )
  assert.equal(container.querySelectorAll('tbody tr').length, 25)
  await click(pagination, 'Next')
  assert.equal(container.querySelectorAll('tbody tr').length, 9)
  assert.match(pagination.textContent, /Page 2 \/ 2/)
  const search = container.querySelector('input[aria-label="Search menus"]')
  await fill(search, 'Operations 29')
  assert.equal(container.querySelectorAll('tbody tr').length, 1)
  assert.match(pagination.textContent, /Page 1 \/ 1/)
  await fill(search, '')
  assert.equal(container.querySelectorAll('tbody tr').length, 25)
  assert.match(pagination.textContent, /Page 1 \/ 2/)
  await fill(pagination.querySelector('select'), '10')
  assert.equal(container.querySelectorAll('tbody tr').length, 10)
  assert.match(pagination.textContent, /Page 1 \/ 4/)
})

test('ordinary overview renders account shortcuts without workspace, inventory or agent requests', async (t) => {
  const container = await mount(t, OverviewPage, ['sessions.read'])
  assert.match(container.textContent, /Welcome back/)
  assert.ok(container.querySelector('a[href="#/workspace"]'))
  assert.equal(container.querySelector('a[href="#/account/models"]'), null)
})

test('page header does not create a back-to-workspace button without a handler', async (t) => {
  const container = await mount(t, PageHeader, [], { title: 'Standalone page' })
  assert.equal(container.querySelector('button'), null)
  assert.match(container.textContent, /Standalone page/)
})

test('navigation API uses the authenticated v2 client independently of chat state', async (t) => {
  await mount(t, PageHeader, [], { title: 'API' })
  apiClient.get = async (path) => {
    assert.equal(path, '/navigation')
    return { version: 4, items: data.items }
  }
  assert.deepEqual(await consoleApi.navigation(), {
    version: 4,
    items: data.items,
  })
})
