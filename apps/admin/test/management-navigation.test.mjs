import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { JSDOM } from 'jsdom'
import { registerSource } from './helpers/onboarding-source.mjs'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://fixture.example/',
  pretendToBeVisual: true,
})
for (const name of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLFormElement',
  'HTMLButtonElement',
  'Element',
  'Node',
  'NodeFilter',
  'Event',
  'HashChangeEvent',
  'CustomEvent',
  'MutationObserver',
  'DocumentFragment',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
])
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: dom.window[name],
  })
window.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
})
window.HTMLElement.prototype.scrollIntoView = function () {}
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.WebSocket = class {
  constructor() {
    throw new Error('Management pages must not open a chat WebSocket')
  }
}
const { createElement: h, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const hooks = registerSource()
// Only execution-dependent leaf pages and auth transport are fixtures. The
// console shell, registered routes, navigation and management panels are real.
const leaves = new Map([
  ['components/demo.tsx', ['Demo', 'workbench']],
  ['components/console/overview-page.tsx', ['OverviewPage', 'overview']],
  ['components/console/account-page.tsx', ['AccountPage', 'account']],
  ['components/pages/service-page.tsx', ['ServicePage', 'service']],
])
const fixtures = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/components/workspace-context.tsx'))
      throw new Error('Console management must never import WorkspaceProvider')
    if (url.endsWith('/components/auth/auth-context.tsx'))
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export const useAuth = () => globalThis.consoleAuth',
      }
    for (const [path, [name, leaf]] of leaves)
      if (url.endsWith(`/${path}`))
        return {
          format: 'module',
          shortCircuit: true,
          source: `import {createElement,useEffect} from 'react'; export function ${name}({section}={}) { useEffect(() => { globalThis.consoleLeaves.push('${leaf}:mount'); return () => globalThis.consoleLeaves.push('${leaf}:unmount') }, []); return createElement('p', {'data-fixture':'${leaf}'}, '${leaf}' + (section ? ':'+section : '')) }`,
        }
    return nextLoad(url, context)
  },
})
const { ConsoleShell } =
  await import('../src/components/console/console-shell.tsx')
const { consoleModules } = await import('../src/features/console/modules.ts')
const { navigationTitle } =
  await import('../src/features/console/navigation.ts')
const { apiClient } = await import('../src/lib/api/index.ts')
const { saveStoredSession, clearStoredSession } =
  await import('../src/features/auth/session.ts')
// React.lazy imports happen after initial render, so loaders stay installed.
test.after(() => {
  fixtures.deregister()
  hooks.deregister()
  dom.window.close()
})
const messages = JSON.parse(
  readFileSync(new URL('../messages/zh-CN.json', import.meta.url), 'utf8'),
)
const memberPermissions = ['devices.read', 'sessions.read', 'sessions.run']
const adminPermissions = [
  ...memberPermissions,
  'users.read',
  'users.manage',
  'roles.manage',
  'devices.inventory.read',
  'models.manage',
  'audit.read',
  'menus.read',
  'menus.manage',
  'settings.manage',
  'agents.manage',
]
const groups = [
  { id: 'access', title: '用户与权限', icon: 'users' },
  { id: 'agent-management', title: '智能体管理', icon: 'bot' },
  { id: 'system', title: '系统管理', icon: 'settings' },
  { id: 'account', title: '个人中心', icon: 'user' },
].map((group, order) => ({
  ...group,
  kind: 'group',
  moduleId: null,
  parentId: null,
  order: order + 1,
  visible: true,
  roleIds: [],
}))
const items = [
  ...groups,
  ...consoleModules.map((module, order) => ({
    id: module.id,
    kind: 'page',
    moduleId: module.id,
    parentId: ['agents', 'knowledge', 'skills', 'tools'].includes(module.id)
      ? 'agent-management'
      : module.id.includes('.')
        ? module.id.split('.')[0]
        : null,
    title: module.title,
    icon: module.icon,
    order,
    visible: true,
    roleIds: [],
  })),
]
const menuData = {
  version: 1,
  items,
  modules: consoleModules.map(({ id, route, title, icon, permissions }) => ({
    id,
    route,
    title,
    icon,
    permissions,
  })),
  icons: [
    'gauge',
    'users',
    'shield',
    'menu',
    'bot',
    'key',
    'monitor',
    'settings',
    'user',
    'history',
    'paintbrush',
    'smartphone',
    'folder',
  ],
  roles: [
    { id: 'admin', name: '管理员' },
    { id: 'member', name: '普通用户' },
  ],
}
const responses = {
  '/admin/users': {
    users: [
      {
        userId: 'fixture-user',
        username: 'fixture-member',
        displayName: 'Fixture Member',
        role: 'member',
        roles: ['member'],
        disabled: false,
      },
    ],
    total: 1,
    page: 1,
    pageSize: 10,
  },
  '/admin/roles': { roles: [], permissions: [] },
  '/admin/devices': { devices: [] },
  '/admin/models/providers': { providers: [] },
  '/admin/models/default': { selection: null },
  '/admin/audit': { events: [] },
}
async function settle() {
  await act(async () => {
    await delay(25)
  })
}
async function until(check) {
  for (let attempt = 0; attempt < 80; attempt++) {
    await settle()
    if (check()) return
  }
  assert.ok(check(), 'UI did not settle')
}
async function clickLabel(scope, label, selector = 'button') {
  const element = [...scope.querySelectorAll(selector)].find(
    (item) => item.textContent.trim() === label,
  )
  assert.ok(element, `Missing ${selector}: ${label}`)
  assert.notEqual(element.disabled, true)
  await act(async () => {
    element.click()
    await delay(20)
  })
  await settle()
}
async function mount(
  t,
  { hash = '#/', permissions = adminPermissions, hidden = false } = {},
) {
  window.localStorage.clear()
  window.sessionStorage.clear()
  window.history.replaceState(null, '', hash)
  globalThis.consoleLeaves = []
  let account = {
    userId: 'fixture-account',
    displayName: 'Fixture Account',
    username: 'fixture',
    role: permissions === adminPermissions ? 'admin' : 'member',
    roles: [permissions === adminPermissions ? 'admin' : 'member'],
    permissions,
    authzVersion: 1,
    accessToken: 'fixture-token',
  }
  const applyAccount = () => {
    globalThis.consoleAuth = {
      session: account,
      me: account,
      can: (permission) => account.permissions.includes(permission),
      signOut() {},
    }
    saveStoredSession(account)
  }
  applyAccount()
  const calls = []
  const failures = new Set()
  let menus = structuredClone(menuData)
  if (hidden)
    menus.items.forEach((item) => {
      item.visible = false
    })
  t.mock.method(apiClient, 'get', async (path, options) => {
    calls.push({ path, options })
    if (failures.has(path)) throw new Error(`Fixture unavailable: ${path}`)
    if (path === '/navigation')
      return { version: menus.version, items: menus.items }
    if (path === '/admin/menus') return menus
    assert.ok(Object.hasOwn(responses, path), `Unexpected API read: ${path}`)
    return structuredClone(responses[path])
  })
  t.mock.method(apiClient, 'post', async (path, body) => {
    calls.push({ path, body })
    assert.equal(path, '/admin/menus/reset')
    assert.equal(body.version, menus.version)
    menus = { ...structuredClone(menuData), version: menus.version + 1 }
    return menus
  })
  const container = document.createElement('div')
  document.body.append(container)
  let root
  let closed = true
  const render = async () => {
    if (closed) {
      root = createRoot(container)
      closed = false
    }
    await act(async () =>
      root.render(
        h(
          NextIntlClientProvider,
          { locale: 'zh-CN', messages, timeZone: 'Asia/Shanghai' },
          h(ConsoleShell),
        ),
      ),
    )
    await settle()
  }
  const unmount = async () => {
    if (closed) return
    closed = true
    await act(async () => root.unmount())
  }
  t.after(async () => {
    await unmount()
    container.remove()
    clearStoredSession()
  })
  await render()
  return {
    container,
    calls,
    failures,
    content: () => container.querySelector('[data-console-content]'),
    navigation: () => container.querySelector('nav[aria-label="平台导航"]'),
    async remount() {
      await unmount()
      await render()
    },
    async hash(next) {
      await act(async () => {
        window.location.hash = next
        await delay(20)
      })
      await settle()
    },
    async permissions(next) {
      await act(async () => {
        account = {
          ...account,
          permissions: next,
          authzVersion: account.authzVersion + 1,
        }
        applyAccount()
      })
      await render()
    },
  }
}

const sections = [
  ['用户管理', '#/access/users', '/admin/users'],
  ['角色与权限', '#/access/roles', '/admin/roles'],
  ['设备运维', '#/operations/devices', '/admin/devices'],
  ['模型管理', '#/models', '/admin/models/providers'],
  ['审计日志', '#/system/audit', '/admin/audit'],
]

test('default login route opens console overview and no chat provider or runtime API', async (t) => {
  const view = await mount(t)
  await until(() => view.content().querySelector('[data-fixture="overview"]'))
  assert.equal(window.location.hash, '#/overview')
  assert.ok(view.container.querySelector('[data-console-shell]'))
  assert.deepEqual(
    view.calls.map(({ path }) => path),
    ['/navigation'],
  )
  assert.deepEqual(globalThis.consoleLeaves, ['overview:mount'])
})

test('Agent management contains four independently addressed pages and retains single-group expansion', async (t) => {
  const view = await mount(t)
  await until(() => view.content().querySelector('[data-fixture="overview"]'))
  const navigation = view.navigation()
  assert.equal(navigation.querySelector('[aria-expanded="true"]'), null)
  assert.equal(navigation.querySelector('a[href="#/agents"]'), null)
  await clickLabel(navigation, '智能体管理')
  for (const [route, title] of [
    ['#/agents', '智能体列表'],
    ['#/knowledge', '知识库'],
    ['#/skills', '技能管理'],
    ['#/tools', '工具管理'],
  ])
    assert.equal(
      navigation.querySelector(`a[href="${route}"]`)?.textContent,
      title,
    )
  assert.equal(navigation.querySelectorAll('[aria-expanded="true"]').length, 1)
  await clickLabel(navigation, '用户与权限')
  assert.equal(navigation.querySelector('a[href="#/agents"]'), null)
  assert.ok(navigation.querySelector('a[href="#/access/users"]'))
  assert.equal(navigation.querySelectorAll('[aria-expanded="true"]').length, 1)
  await clickLabel(navigation, '用户与权限')
  assert.equal(navigation.querySelector('[aria-expanded="true"]'), null)
})

test('default Agent group and page labels are translated without changing custom labels', () => {
  const group = items.find((item) => item.id === 'agent-management')
  const page = items.find((item) => item.moduleId === 'agents')
  const english = (_chinese, text) => text
  assert.equal(navigationTitle(group, english), 'Agent management')
  assert.equal(navigationTitle(page, english), 'Agents')
  assert.equal(
    navigationTitle({ ...group, title: 'Company agents' }, english),
    'Company agents',
  )
  assert.equal(
    navigationTitle({ ...page, title: 'Company catalog' }, english),
    'Company catalog',
  )
})

test('console menus mount all five real management panels and their scoped APIs', async (t) => {
  const view = await mount(t)
  for (const [label, route, endpoint] of sections) {
    const before = view.calls.filter(({ path }) => path === endpoint).length
    if (label === '用户管理') await clickLabel(view.navigation(), '用户与权限')
    if (label === '审计日志') await clickLabel(view.navigation(), '系统管理')
    await clickLabel(view.navigation(), label, 'a')
    await until(
      () => view.calls.filter(({ path }) => path === endpoint).length > before,
    )
    assert.equal(window.location.hash, route)
    assert.equal(view.content().querySelector('h1')?.textContent, label)
    assert.equal(
      view.navigation().querySelector('[aria-current="page"]')?.textContent,
      label,
    )
  }
  assert.ok(view.calls.some(({ path }) => path === '/admin/models/default'))
  assert.deepEqual(
    view.calls.find(({ path }) => path === '/admin/users').options,
    { query: { page: 1, pageSize: 10, search: '' } },
  )
  assert.equal(globalThis.consoleLeaves.includes('workbench:mount'), false)
})

test('each real management panel reports failures and retries without blocking console navigation', async (t) => {
  const view = await mount(t)
  for (const [label, , endpoint] of sections) {
    view.failures.add(endpoint)
    if (label === '用户管理') await clickLabel(view.navigation(), '用户与权限')
    if (label === '审计日志') await clickLabel(view.navigation(), '系统管理')
    await clickLabel(view.navigation(), label, 'a')
    await until(() => view.content().querySelector('[role="alert"]'))
    assert.match(
      view.content().querySelector('[role="alert"]').textContent,
      /Fixture unavailable:/,
    )
    const before = view.calls.filter(({ path }) => path === endpoint).length
    view.failures.delete(endpoint)
    await clickLabel(view.content(), '重试')
    await until(() => !view.content().querySelector('[role="alert"]'))
    assert.equal(
      view.calls.filter(({ path }) => path === endpoint).length,
      before + 1,
    )
  }
})

test('legacy management entry resolves to the first permitted management page and survives remount/history', async (t) => {
  const view = await mount(t, { hash: '#/management' })
  await until(() => view.content().textContent.includes('Fixture Member'))
  assert.equal(window.location.hash, '#/access/users')
  await view.remount()
  await until(() => view.content().textContent.includes('Fixture Member'))
  assert.equal(window.location.hash, '#/access/users')
  await clickLabel(view.navigation(), '用户与权限')
  await clickLabel(view.navigation(), '角色与权限', 'a')
  assert.equal(window.location.hash, '#/access/roles')
  await act(async () => {
    window.history.back()
    await delay(40)
  })
  assert.equal(window.location.hash, '#/access/users')
  await until(() => view.content().textContent.includes('Fixture Member'))
  await act(async () => {
    window.history.forward()
    await delay(40)
  })
  assert.equal(window.location.hash, '#/access/roles')
  await until(
    () => view.content().querySelector('h1')?.textContent === '角色与权限',
  )
})

test('custom management role legacy route selects its allowed module', async (t) => {
  const view = await mount(t, {
    hash: '#/management',
    permissions: ['audit.read'],
  })
  await until(() => view.calls.some(({ path }) => path === '/admin/audit'))
  assert.equal(window.location.hash, '#/system/audit')
  assert.equal(view.navigation().textContent.includes('用户管理'), false)
  assert.equal(view.content().querySelector('h1')?.textContent, '审计日志')
})

test('ordinary accounts cannot open management and unknown destinations show 404 without fallback chat', async (t) => {
  const view = await mount(t, {
    hash: '#/management',
    permissions: memberPermissions,
  })
  await until(() => view.content().querySelector('h1')?.textContent === '403')
  assert.equal(view.navigation().textContent.includes('用户管理'), false)
  assert.equal(
    view.calls.some(({ path }) => path.startsWith('/admin/')),
    false,
  )
  await view.hash('#/not-a-page')
  assert.equal(view.content().querySelector('h1')?.textContent, '404')
  assert.equal(globalThis.consoleLeaves.includes('workbench:mount'), false)
})

test('permission revocation removes current management content and does not repeat privileged reads', async (t) => {
  const view = await mount(t, { hash: '#/access/users' })
  await until(() => view.content().textContent.includes('Fixture Member'))
  const before = view.calls.filter(({ path }) =>
    path.startsWith('/admin/'),
  ).length
  await view.permissions(memberPermissions)
  await until(() => view.content().querySelector('h1')?.textContent === '403')
  assert.equal(view.content().textContent.includes('Fixture Member'), false)
  assert.equal(view.navigation().textContent.includes('用户管理'), false)
  assert.equal(
    view.calls.filter(({ path }) => path.startsWith('/admin/')).length,
    before,
  )
})

test('hidden navigation retains the authorized recovery entry and restoring defaults refreshes the shell', async (t) => {
  const view = await mount(t, { hidden: true })
  await until(() => view.content().querySelector('[data-fixture="overview"]'))
  assert.equal(view.navigation().querySelector('a'), null)
  await clickLabel(view.container, '菜单管理与恢复', 'a')
  await until(() => view.content().textContent.includes('恢复默认'))
  await clickLabel(view.content(), '恢复默认')
  assert.equal(
    view.calls.some(({ path }) => path === '/admin/menus/reset'),
    false,
  )
  await clickLabel(document.body.querySelector('[role="dialog"]'), '确认')
  await until(() => view.navigation().textContent.includes('用户与权限'))
  await clickLabel(view.navigation(), '用户与权限')
  assert.ok(view.navigation().querySelector('a[href="#/access/users"]'))
  assert.ok(view.calls.some(({ path }) => path === '/admin/menus/reset'))
  assert.equal(window.location.hash, '#/access/menus')
})

test('workbench is mounted on demand and unmounted when a management module opens', async (t) => {
  const view = await mount(t)
  await until(() => view.content().querySelector('[data-fixture="overview"]'))
  assert.equal(globalThis.consoleLeaves.includes('workbench:mount'), false)
  await clickLabel(view.navigation(), 'Agent 工作台', 'a')
  await until(() => view.content().querySelector('[data-fixture="workbench"]'))
  assert.equal(
    globalThis.consoleLeaves.filter((entry) => entry === 'workbench:mount')
      .length,
    1,
  )
  await clickLabel(view.navigation(), '用户与权限')
  assert.ok(view.navigation().querySelector('a[href="#/access/users"]'))
  await clickLabel(view.navigation(), '用户管理', 'a')
  await until(() => view.content().textContent.includes('Fixture Member'))
  assert.equal(
    globalThis.consoleLeaves.filter((entry) => entry === 'workbench:unmount')
      .length,
    1,
  )
})

for (const [oldHash, expected, leaf] of [
  [
    '#/session/fixture-session',
    '#/workspace/session/fixture-session',
    'workbench',
  ],
  ['#/device/fixture-device', '#/workspace/device/fixture-device', 'workbench'],
  [
    '#/new-session/fixture-device',
    '#/workspace/new-session/fixture-device',
    'workbench',
  ],
  ['#/settings/archived-sessions', '#/workspace/archived', 'workbench'],
  ['#/settings', '#/account/profile', 'account'],
  ['#/settings/appearance', '#/account/appearance', 'account'],
  ['#/settings/mobile-connections', '#/account/mobile', 'account'],
  ['#/service', '#/system/service', 'service'],
]) {
  test(`legacy ${oldHash} normalizes without breaking its module`, async (t) => {
    const view = await mount(t, { hash: oldHash })
    await until(() => view.content().querySelector(`[data-fixture="${leaf}"]`))
    assert.equal(window.location.hash, expected)
    assert.equal(view.content().querySelector('[role="alert"]'), null)
  })
}
