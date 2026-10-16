import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { ApiRouter } from '../http/api-router.ts'
import { IdentityService } from '../identity/service.ts'
import { AccountManagement } from '../management/accounts.ts'
import { registerManagementRoutes } from '../management/routes.ts'
import {
  defaultMenuItems,
  validateMenuItems,
  visibleMenuItems,
} from '../management/navigation.ts'
import { DashboardService, histogram } from '../management/dashboard.ts'
import { withTestDatabase } from './support/database.mjs'

async function fixture(t) {
  const db = await withTestDatabase(t),
    changed = [],
    disconnected = []
  const identity = new IdentityService(db, {
    secret: 'synthetic-management-secret',
    onAccountChanged: (id) => changed.push(id),
  })
  await identity.seedBuiltinRoles()
  const admin = await identity.createUser(
    { username: 'admin', displayName: 'Admin', password: 'password-123' },
    { role: 'admin' },
  )
  const member = await identity.createUser({
    username: 'member',
    displayName: 'Member',
    password: 'password-123',
  })
  const router = new ApiRouter(identity.authorize)
  registerManagementRoutes(router, identity, {
    isOnline: () => false,
    disconnect: async (id) => disconnected.push(id),
  })
  const server = createServer((req, res) =>
    router.handle(req, res, { signal: AbortSignal.timeout(5000) }),
  )
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(resolve)
      }),
  )
  const base = `http://127.0.0.1:${server.address().port}/api/v2`
  async function request(path, method = 'GET', body, user = admin) {
    const login = await identity.issueLogin(user.userId)
    const response = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${login.accessToken}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    }
  }
  return { db, identity, admin, member, changed, disconnected, request }
}

test('management permission gate, pagination and atomic new-user role validation', async (t) => {
  const f = await fixture(t)
  assert.equal(
    (await f.request('/admin/users', 'GET', undefined, f.member)).status,
    403,
  )
  const list = await f.request('/admin/users?page=1&pageSize=1&search=adm')
  assert.equal(list.status, 200)
  assert.equal(list.body.total, 1)
  assert.equal(list.body.users[0].username, 'admin')
  assert.equal(JSON.stringify(list.body).includes('password_hash'), false)
  const rejected = await f.request('/admin/users', 'POST', {
    username: 'rejected',
    displayName: 'Rejected',
    password: 'password-123',
    roles: ['missing'],
  })
  assert.equal(rejected.status, 422)
  assert.equal(
    (await f.db.query("SELECT id FROM users WHERE username='rejected'")).length,
    0,
  )
  const created = await f.request('/admin/users', 'POST', {
    username: 'created',
    displayName: 'Created',
    password: 'password-123',
    roles: ['member'],
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  assert.equal(created.body.resetRequired, true)
})

test('role changes revoke access and custom managers cannot escalate indirect grants', async (t) => {
  const f = await fixture(t),
    management = new AccountManagement(f.identity)
  const restricted = await management.saveRole(f.admin, undefined, {
    name: 'Managers',
    permissions: ['users.manage', 'roles.manage'],
  })
  await management.updateUser(f.admin, f.member.userId, {
    roles: [restricted.id],
  })
  const actor = await f.identity.getUser(f.member.userId)
  assert.equal(
    (
      await f.request(
        '/admin/roles',
        'POST',
        { name: 'Escalation', permissions: ['models.manage'] },
        actor,
      )
    ).status,
    403,
  )
  assert.equal(
    (
      await f.request(
        `/admin/users/${f.admin.userId}`,
        'PATCH',
        { disabled: true },
        actor,
      )
    ).status,
    403,
  )
  assert.equal(
    (
      await f.request('/admin/roles/admin', 'PATCH', {
        name: 'Changed',
        permissions: [],
      })
    ).status,
    409,
  )
  const login = await f.identity.issueLogin(actor.userId)
  await management.saveRole(f.admin, restricted.id, {
    name: 'Managers',
    permissions: ['users.manage'],
  })
  assert.equal(await f.identity.authenticateToken(login.accessToken), null)
  assert.ok(f.changed.includes(actor.userId))
})

test('concurrent admin removals retain an active administrator and reject stale actor', async (t) => {
  const f = await fixture(t),
    management = new AccountManagement(f.identity)
  const second = await f.identity.createUser(
    { username: 'admin2', displayName: 'Admin 2', password: 'password-123' },
    { role: 'admin' },
  )
  const outcomes = await Promise.allSettled([
    management.updateUser(f.admin, second.userId, { disabled: true }),
    management.updateUser(second, f.admin.userId, { disabled: true }),
  ])
  assert.equal(
    outcomes.filter((result) => result.status === 'fulfilled').length,
    1,
  )
  assert.equal(
    Number(
      (
        await f.db.query(
          "SELECT count(*) FROM users WHERE role='admin' AND disabled=0 AND deleted_at IS NULL",
        )
      )[0].count,
    ),
    1,
  )
})

test('admin recovery cannot set existing passwords, soft delete retains owner and restore stays disabled', async (t) => {
  const f = await fixture(t)
  const login = await f.identity.issueLogin(f.member.userId)
  assert.equal(
    (
      await f.request(`/admin/users/${f.member.userId}`, 'PATCH', {
        password: 'malicious-reset',
      })
    ).status,
    409,
  )
  assert.equal(
    (
      await f.request(
        `/admin/users/${f.member.userId}/password-reset`,
        'POST',
        {},
      )
    ).status,
    200,
  )
  assert.equal(await f.identity.authenticateToken(login.accessToken), null)
  assert.equal(
    (await f.request(`/admin/users/${f.member.userId}`, 'DELETE')).status,
    204,
  )
  const restored = await f.request(
    `/admin/users/${f.member.userId}/restore`,
    'POST',
    {},
  )
  assert.equal(restored.status, 200)
  assert.equal(restored.body.userId, f.member.userId)
  assert.equal(restored.body.disabled, true)
  assert.equal(restored.body.deletedAt, null)
})

test('menus persist with conflict detection, permission intersection and recovery entry', async (t) => {
  const f = await fixture(t),
    original = await f.request('/admin/menus')
  assert.equal(original.status, 200)
  for (const id of ['agents', 'knowledge', 'skills', 'tools']) {
    const page = original.body.items.find((item) => item.id === id)
    assert.equal(page.kind, 'page')
    assert.equal(
      page.parentId,
      'agent-management',
      `${id} must share the Agent management group`,
    )
    assert.equal(
      original.body.modules.find((item) => item.id === id).route,
      `#/${id}`,
    )
  }
  const items = structuredClone(original.body.items)
  items.find((item) => item.id === 'access.users').visible = false
  const updated = await f.request('/admin/menus', 'PUT', {
    version: original.body.version,
    items,
  })
  assert.equal(updated.status, 200, JSON.stringify(updated.body))
  assert.equal(updated.body.version, original.body.version + 1)
  assert.equal(
    (
      await f.request('/admin/menus', 'PUT', {
        version: original.body.version,
        items,
      })
    ).status,
    409,
  )
  assert.equal(
    (await f.request('/navigation')).body.items.some(
      (item) => item.id === 'access.users',
    ),
    false,
  )
  const memberMenu = await f.request('/navigation', 'GET', undefined, f.member)
  assert.equal(
    memberMenu.body.items.some((item) => item.id === 'access'),
    false,
  )
  assert.ok(memberMenu.body.items.some((item) => item.id === 'workbench'))
  assert.equal(
    memberMenu.body.items.some((item) =>
      ['agent-management', 'agents', 'knowledge', 'skills', 'tools'].includes(
        item.id,
      ),
    ),
    false,
  )
  assert.equal(
    (
      await f.request('/admin/menus/reset', 'POST', {
        version: updated.body.version,
      })
    ).status,
    200,
  )
  const bad = structuredClone(items)
  bad.find((item) => item.id === 'access').parentId = 'system'
  assert.throws(
    () => validateMenuItems(bad, ['admin', 'member']),
    /groups must be root/,
  )
  const narrowed = defaultMenuItems()
  narrowed.find((item) => item.id === 'workbench').roleIds = ['admin']
  assert.equal(
    visibleMenuItems(narrowed, f.member).some(
      (item) => item.id === 'workbench',
    ),
    false,
  )
})

test('device operations expose only safe inventory and block before disconnect', async (t) => {
  const f = await fixture(t),
    now = new Date().toISOString()
  await f.db.query(
    "INSERT INTO connectors(id,user_id,name,status,token_hash,token_prefix,created_at,updated_at) VALUES('con_test',$1,'Device','offline','synthetic-secret-hash','prefix',$2,$2)",
    [f.member.userId, now],
  )
  const inventory = await f.request('/admin/devices')
  assert.equal(inventory.status, 200)
  assert.equal(inventory.body.devices[0].userId, f.member.userId)
  assert.equal(
    JSON.stringify(inventory.body).includes('synthetic-secret-hash'),
    false,
  )
  assert.equal(
    (
      await f.request('/admin/devices/con_test/block', 'POST', {
        reason: 'maintenance',
      })
    ).status,
    200,
  )
  assert.ok(
    (
      await f.db.query(
        "SELECT connection_blocked_at FROM connectors WHERE id='con_test'",
      )
    )[0].connection_blocked_at,
  )
  assert.deepEqual(f.disconnected, ['con_test'])
  assert.equal(
    (await f.request('/admin/devices/con_test/resume', 'POST', {})).status,
    200,
  )
  assert.equal(
    (
      await f.db.query(
        "SELECT connection_blocked_at FROM connectors WHERE id='con_test'",
      )
    )[0].connection_blocked_at,
    null,
  )
})

test('settings keep secrets write-only, preserve omitted keys and publish announcements', async (t) => {
  const f = await fixture(t)
  const saved = await f.request('/admin/settings', 'PATCH', {
    oauth: {
      clientSecret: 'synthetic-oauth-secret',
      clientId: 'synthetic-client',
    },
    email: {
      apiKey: 'synthetic-resend-key',
      fromAddress: 'sender@example.test',
    },
  })
  assert.equal(saved.status, 200)
  assert.equal(
    JSON.stringify(saved.body).includes('synthetic-oauth-secret'),
    false,
  )
  assert.equal(
    JSON.stringify(saved.body).includes('synthetic-resend-key'),
    false,
  )
  await f.request('/admin/settings', 'PATCH', { email: { enabled: true } })
  assert.equal(
    (await f.identity.settingsObject('email_verification')).apiKey,
    'synthetic-resend-key',
  )
  assert.equal(
    (
      await f.request('/admin/announcement', 'PUT', {
        enabled: true,
        markdown: '',
      })
    ).status,
    422,
  )
  const published = await f.request('/admin/announcement', 'PUT', {
    enabled: true,
    markdown: 'Hello',
  })
  assert.equal(published.status, 200, JSON.stringify(published.body))
  const viewed = await f.request('/announcement', 'GET', undefined, f.member)
  assert.equal(viewed.body.announcement.markdown, 'Hello')
})

test('dashboard computes persisted statistics from real activity and validates timezone', async (t) => {
  const f = await fixture(t),
    dashboard = new DashboardService(f.identity)
  await f.db.query(
    'INSERT INTO platform_user_activity(user_id,activity_date,first_seen_at,last_seen_at,event_count) VALUES($1,$2,$3,$3,1)',
    [f.member.userId, '2026-10-15', '2026-10-15T04:00:00.000Z'],
  )
  await f.db.query('UPDATE users SET created_at=$1', [
    '2026-10-01T00:00:00.000Z',
  ])
  const snapshot = await dashboard.snapshot('2026-10-15', 'Asia/Shanghai')
  assert.equal(snapshot.users, 1)
  const overview = await dashboard.overview(
    '2026-10-15',
    '2026-10-15',
    'Asia/Shanghai',
  )
  assert.equal(overview.summary.totalUsers, 2)
  assert.equal(overview.summary.dau, 1)
  assert.equal(overview.summary.totalMessages, 0)
  assert.equal(overview.summary.wau, 1)
  assert.equal(overview.series.length, 1)
  await assert.rejects(
    dashboard.overview('2026-10-15', '2026-10-15', 'Invalid/Zone'),
    /timezone/,
  )
  assert.deepEqual(
    histogram([0, 5, 6, 20, 21], [0, 5, 20]).map((row) => row.count),
    [2, 2, 1],
  )
})
