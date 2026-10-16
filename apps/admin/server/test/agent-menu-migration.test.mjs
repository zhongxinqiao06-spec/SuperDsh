import assert from 'node:assert/strict'
import test from 'node:test'
import { ensureSchema } from '../infrastructure/schema.ts'
import {
  defaultMenuItems,
  validateMenuItems,
  visibleMenuItems,
} from '../management/navigation.ts'
import { withTestDatabase } from './support/database.mjs'

test('v2_41 stored standalone Agent menus become one group without losing custom titles or access restrictions', async (t) => {
  const db = await withTestDatabase(t)
  const pages = ['agents', 'knowledge', 'skills', 'tools']
  const old = defaultMenuItems()
    .filter((item) => item.id !== 'agent-management')
    .map((item) => {
      if (item.id === 'agents')
        return { ...item, parentId: null, title: '智能体管理', order: 2 }
      if (item.id === 'knowledge')
        return {
          ...item,
          parentId: null,
          title: '公司知识库',
          roleIds: ['admin'],
          order: 8,
        }
      if (item.id === 'skills')
        return { ...item, parentId: null, visible: false, order: 9 }
      if (item.id === 'tools') return { ...item, parentId: null, order: 10 }
      if (item.id === 'models')
        return { ...item, title: '自定义模型入口', roleIds: ['admin'] }
      return item
    })
  await db.query(
    "INSERT INTO navigation_settings(id,version,items_json,updated_at) VALUES('global',11,$1,$2)",
    [JSON.stringify(old), new Date().toISOString()],
  )
  await db.query("UPDATE alembic_version SET version_num='v2_41'")
  await ensureSchema(db)
  const [stored] = await db.query(
    "SELECT * FROM navigation_settings WHERE id='global'",
  )
  const items = JSON.parse(stored.items_json)
  assert.equal(stored.version, 12)
  const group = items.find((item) => item.id === 'agent-management')
  assert.equal(group.kind, 'group')
  assert.equal(group.title, '智能体管理')
  assert.equal(group.parentId, null)
  for (const [order, id] of pages.entries()) {
    const page = items.find((item) => item.id === id)
    assert.equal(page.parentId, group.id)
    assert.equal(page.moduleId, id)
    assert.equal(page.order, order)
  }
  assert.equal(items.find((item) => item.id === 'agents').title, '智能体列表')
  assert.equal(
    items.find((item) => item.id === 'knowledge').title,
    '公司知识库',
  )
  assert.deepEqual(items.find((item) => item.id === 'knowledge').roleIds, [
    'admin',
  ])
  assert.equal(items.find((item) => item.id === 'skills').visible, false)
  assert.deepEqual(
    items.filter((item) => !pages.includes(item.id) && item.id !== group.id),
    old.filter((item) => !pages.includes(item.id)),
  )
  assert.equal(
    validateMenuItems(items, ['admin', 'member']).length,
    items.length,
  )
  assert.equal(
    visibleMenuItems(items, { permissions: [], roles: ['member'] }).some(
      (item) => item.id === group.id,
    ),
    false,
  )
  await ensureSchema(db)
  assert.deepEqual(
    (
      await db.query(
        "SELECT version,items_json FROM navigation_settings WHERE id='global'",
      )
    )[0],
    { version: 12, items_json: stored.items_json },
  )
  assert.equal(
    (await db.query('SELECT version_num FROM alembic_version'))[0].version_num,
    'v2_42',
  )
})
