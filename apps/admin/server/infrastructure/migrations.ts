import type { SqlConnection } from './database.ts'
import {
  defaultMenuItems,
  groupAgentMenuItems,
  type MenuNode,
} from '../management/navigation.ts'
import { memberPermissions, permissions } from '../identity/permissions.ts'

const now = () => new Date().toISOString()
type LegacyUser = {
  id: string
  username: string | null
  email: string | null
  role: string
}

function tableDefinition(ddl: string, table: string): string {
  const match = new RegExp(`CREATE TABLE ${table} \\([\\s\\S]*?\\n\\);`).exec(
    ddl,
  )
  if (!match) throw new Error(`Migration schema is missing ${table}`)
  return match[0].replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS')
}
async function tables(
  connection: SqlConnection,
  ddl: string,
  names: string[],
): Promise<void> {
  for (const name of names) await connection.query(tableDefinition(ddl, name))
}

/** Incremental product migrations preserve existing owners and runtime data. */
export async function migrateProductSchema(
  connection: SqlConnection,
  revision: string,
  ddl: string,
): Promise<void> {
  const match = /^v2_(3[5-9]|4[0-2])$/.exec(revision)
  if (!match)
    throw new Error(
      `Unsupported database revision ${revision}; upgrade pre-product databases to v2_35 with their original release before switching to Node`,
    )
  const current = Number(match[1])
  const orphaned = await connection.query<{ id: string }>(
    'SELECT c.id FROM connectors c LEFT JOIN users u ON u.id=c.user_id WHERE u.id IS NULL LIMIT 1',
  )
  if (orphaned.length)
    throw new Error(
      'Database contains a connector without an existing owner; resolve ownership before migrating',
    )
  if (current < 36) {
    await connection.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT,
      ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS deleted_at TEXT, ADD COLUMN IF NOT EXISTS deleted_by TEXT,
      ADD COLUMN IF NOT EXISTS reset_required INTEGER NOT NULL DEFAULT 0`)
    await connection.query(`ALTER TABLE connectors ADD COLUMN IF NOT EXISTS connection_blocked_at TEXT,
      ADD COLUMN IF NOT EXISTS connection_blocked_by TEXT, ADD COLUMN IF NOT EXISTS connection_blocked_reason TEXT,
      ADD COLUMN IF NOT EXISTS connector_version TEXT`)
    await tables(connection, ddl, [
      'roles',
      'user_roles',
      'auth_sessions',
      'recovery_codes',
      'identity_audit',
    ])
    for (const [id, grants] of [
      ['admin', Object.keys(permissions)],
      ['member', memberPermissions],
    ] as const)
      await connection.query(
        "INSERT INTO roles(id,name,description,builtin,permissions_json,updated_at) VALUES($1,$1,'',1,$2,$3) ON CONFLICT DO NOTHING",
        [id, JSON.stringify(grants), now()],
      )
    const users = await connection.query<LegacyUser>(
      'SELECT id,email,role,username FROM users ORDER BY created_at,id',
    )
    const alias = (process.env.AGENT_SERVER_LOGIN_ALIAS || '')
        .trim()
        .toLowerCase(),
      email = (process.env.AGENT_SERVER_LOGIN_EMAIL || '').trim().toLowerCase()
    if (alias && !/^[a-z0-9_-]{3,32}$/.test(alias))
      throw new Error('Configured login alias cannot be migrated to a username')
    const target = email ? users.find((row) => row.email === email) : undefined
    if (alias && email && !target)
      throw new Error(
        'Configured login alias target does not exist; resolve it before migrating',
      )
    const used = new Set<string>()
    for (const user of users)
      if (user.username) {
        if (used.has(user.username))
          throw new Error(
            'Duplicate existing username; resolve it before migrating',
          )
        used.add(user.username)
      }
    if (target && alias) {
      if (used.has(alias) && target.username !== alias)
        throw new Error(
          'Configured login alias conflicts with an existing username',
        )
      used.add(alias)
    }
    for (const user of users) {
      if (!['admin', 'member'].includes(user.role))
        throw new Error(
          'Legacy user has an unknown role; resolve it before migrating',
        )
      let username = target?.id === user.id && alias ? alias : user.username
      if (!username) {
        let base = user.id
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, '-')
          .slice(0, 32)
        if (base.length < 3) base = `user-${base}`
        username = base
        let suffix = 1
        while (used.has(username)) username = `${base.slice(0, 26)}-${++suffix}`
      }
      used.add(username)
      await connection.query('UPDATE users SET username=$2 WHERE id=$1', [
        user.id,
        username,
      ])
      await connection.query(
        'INSERT INTO user_roles(user_id,role_id) SELECT $1,$2 WHERE NOT EXISTS(SELECT 1 FROM user_roles WHERE user_id=$1)',
        [user.id, user.role],
      )
    }
    await connection.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)',
    )
    await connection.query(
      'CREATE INDEX IF NOT EXISTS ix_auth_sessions_user_id ON auth_sessions(user_id)',
    )
    await connection.query("UPDATE alembic_version SET version_num='v2_36'")
  }
  if (current < 37) {
    await tables(connection, ddl, [
      'platform_model_defaults',
      'platform_model_providers',
    ])
    await connection.query("UPDATE alembic_version SET version_num='v2_37'")
  }
  if (current < 38) {
    await connection.query(
      'ALTER TABLE platform_model_providers ADD COLUMN IF NOT EXISTS owner_user_id TEXT',
    )
    await connection.query(
      'CREATE INDEX IF NOT EXISTS idx_model_providers_owner ON platform_model_providers(owner_user_id)',
    )
    await connection.query(
      "ALTER TABLE connectors ADD COLUMN IF NOT EXISTS executor_kind TEXT NOT NULL DEFAULT 'desktop'",
    )
    await tables(connection, ddl, ['server_agents'])
    await connection.query("UPDATE alembic_version SET version_num='v2_38'")
  }
  if (current < 39) {
    await tables(connection, ddl, ['navigation_settings'])
    await connection.query(
      "INSERT INTO navigation_settings(id,version,items_json,updated_at) VALUES('global',1,$1,$2) ON CONFLICT DO NOTHING",
      [JSON.stringify(defaultMenuItems()), now()],
    )
    const [admin] = await connection.query<{ permissions_json: string }>(
      "SELECT permissions_json FROM roles WHERE id='admin' AND builtin=1",
    )
    if (!admin)
      throw new Error(
        'Builtin administrator role is missing; resolve it before migrating',
      )
    const old: unknown = JSON.parse(admin.permissions_json)
    if (!Array.isArray(old) || old.some((value) => typeof value !== 'string'))
      throw new Error('Builtin administrator permissions are invalid')
    await connection.query(
      "UPDATE roles SET permissions_json=$1,updated_at=$2 WHERE id='admin'",
      [
        JSON.stringify(
          [...new Set([...old, 'menus.read', 'menus.manage'])].sort(),
        ),
        now(),
      ],
    )
    await connection.query("UPDATE alembic_version SET version_num='v2_39'")
  }
  if (current < 40) {
    await tables(connection, ddl, [
      'business_agent_assets',
      'business_agents',
      'business_agent_sessions',
      'business_agent_artifacts',
    ])
    await connection.query(
      'ALTER TABLE sessions ADD COLUMN IF NOT EXISTS agent_definition_json TEXT',
    )
    const [admin] = await connection.query<{ permissions_json: string }>(
      "SELECT permissions_json FROM roles WHERE id='admin' AND builtin=1",
    )
    if (admin) {
      const grants: unknown = JSON.parse(admin.permissions_json)
      if (
        !Array.isArray(grants) ||
        grants.some((value) => typeof value !== 'string')
      )
        throw new Error('Builtin administrator permissions are invalid')
      await connection.query(
        "UPDATE roles SET permissions_json=$1,updated_at=$2 WHERE id='admin'",
        [JSON.stringify([...new Set([...grants, 'agents.manage'])]), now()],
      )
    }
    const [navigation] = await connection.query<{ items_json: string }>(
      "SELECT items_json FROM navigation_settings WHERE id='global' FOR UPDATE",
    )
    if (navigation) {
      const items = JSON.parse(navigation.items_json) as { id: string }[]
      if (!items.some((item) => item.id === 'agents'))
        await connection.query(
          "UPDATE navigation_settings SET items_json=$1,version=version+1,updated_at=$2 WHERE id='global'",
          [
            JSON.stringify([
              ...items,
              defaultMenuItems().find((item) => item.id === 'agents'),
            ]),
            now(),
          ],
        )
    }
    await connection.query("UPDATE alembic_version SET version_num='v2_40'")
  }
  if (current < 41) {
    await tables(connection, ddl, [
      'business_knowledge_bases',
      'business_agent_skills',
      'business_agent_tools',
    ])
    const [navigation] = await connection.query<{ items_json: string }>(
      "SELECT items_json FROM navigation_settings WHERE id='global' FOR UPDATE",
    )
    if (navigation) {
      const items: unknown = JSON.parse(navigation.items_json)
      if (
        !Array.isArray(items) ||
        items.some((item) => !item || typeof item.id !== 'string')
      )
        throw new Error('Existing navigation configuration is invalid')
      const additions = defaultMenuItems().filter(
        (item) =>
          ['knowledge', 'skills', 'tools'].includes(item.id) &&
          !items.some((existing) => existing.id === item.id),
      )
      if (additions.length)
        await connection.query(
          "UPDATE navigation_settings SET items_json=$1,version=version+1,updated_at=$2 WHERE id='global'",
          [JSON.stringify([...items, ...additions]), now()],
        )
    }
    await connection.query("UPDATE alembic_version SET version_num='v2_41'")
  }
  if (current < 42) {
    const [navigation] = await connection.query<{ items_json: string }>(
      "SELECT items_json FROM navigation_settings WHERE id='global' FOR UPDATE",
    )
    if (navigation) {
      const items: MenuNode[] = JSON.parse(navigation.items_json)
      if (
        !Array.isArray(items) ||
        items.some((item) => !item || typeof item.id !== 'string')
      )
        throw new Error('Existing navigation configuration is invalid')
      const grouped = groupAgentMenuItems(items)
      if (JSON.stringify(grouped) !== JSON.stringify(items))
        await connection.query(
          "UPDATE navigation_settings SET items_json=$1,version=version+1,updated_at=$2 WHERE id='global'",
          [JSON.stringify(grouped), now()],
        )
    }
    await connection.query("UPDATE alembic_version SET version_num='v2_42'")
  }
}
