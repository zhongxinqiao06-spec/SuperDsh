import { createHash, randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { ApiError, utcNow } from '../http/api-router.ts'
import type { Account, ApiRouter } from '../http/api-router.ts'
import type {
  Database,
  Row,
  SqlConnection,
} from '../infrastructure/database.ts'
import { workspaceIdentity } from '../conversations/workspace.ts'
import type { ConnectorHub } from '../devices/connector-hub.ts'
import type { ModelService, Audit } from '../models/model-service.ts'
import type { ModelProxy } from '../models/model-routes.ts'
import { NativeAgentManager } from './native-agent-manager.ts'
import type { NativeAgentAdapter } from './native-agent-manager.ts'
import { NativeHarnessAdapter } from './native-adapter.ts'
import type { NativeAdapterOptions } from './native-adapter.ts'

export interface ServerAgentView {
  status: 'stopped' | 'starting' | 'running' | 'error'
  connectorId: string | null
  runtimeId: string | null
  projectId: string | null
  error: string | null
}
export interface ServerAgentOptions {
  business?: NativeAdapterOptions['business']
  db: Database
  rootDirectory: string
  hub: ConnectorHub
  models: ModelService
  proxy: ModelProxy
  getAccount(userId: string): Promise<Account | null>
  audit: Audit
  adapter?: NativeAgentAdapter
  attachment?: NativeAdapterOptions['attachment']
  platform?: NativeAdapterOptions['platform']
}
const available = (account: Account | null) =>
  Boolean(
    account &&
    !account.disabled &&
    !account.deletedAt &&
    !account.resetRequired,
  )

async function repairManagedProject(
  connection: SqlConnection,
  binding: Row,
  owner: string,
  workspace: string,
  now: string,
): Promise<void> {
  const [managed] = await connection.query(
    "SELECT p.* FROM projects p JOIN connectors c ON c.id=p.connector_id WHERE p.id=$1 AND p.user_id=$2 AND p.connector_id=$3 AND c.user_id=$2 AND c.executor_kind='server-agent' AND c.revoked=0 FOR UPDATE OF p",
    [binding.project_id, owner, binding.connector_id],
  )
  if (!managed)
    throw new ApiError(409, 'server Agent workspace binding is invalid')
  const identity = workspaceIdentity(workspace, process.platform)
  const sameWorkspace = (value: unknown) => {
    if (typeof value !== 'string') return false
    try {
      return workspaceIdentity(value, process.platform).key === identity.key
    } catch {
      return false
    }
  }
  const candidates = await connection.query(
    'SELECT * FROM projects WHERE user_id=$1 AND connector_id=$2 AND id<>$3 FOR UPDATE',
    [owner, binding.connector_id, managed.id],
  )
  const duplicates = candidates.filter((row) =>
    sameWorkspace(row.workspace_path),
  )
  if (
    candidates.some(
      (row) => row.workspace_key === identity.key && !duplicates.includes(row),
    )
  )
    throw new ApiError(
      409,
      'server Agent workspace identity conflicts with another project',
    )
  for (const duplicate of duplicates) {
    // Keep the project and its metadata for recovery; only release the key
    // incorrectly claimed by old projection code so the binding stays canonical.
    await connection.query('UPDATE projects SET workspace_key=$2 WHERE id=$1', [
      duplicate.id,
      `legacy-server-agent:${duplicate.id}`,
    ])
  }
  await connection.query(
    'UPDATE projects SET workspace_path=$2,workspace_key=$3,updated_at=$4 WHERE id=$1',
    [managed.id, identity.display, identity.key, now],
  )
  const sessions = await connection.query(
    'SELECT id,cwd FROM sessions WHERE connector_id=$1 AND runtime_id=$2 AND project_id=ANY($3::text[]) FOR UPDATE',
    [
      binding.connector_id,
      binding.runtime_id,
      [managed.id, ...duplicates.map((row) => row.id)],
    ],
  )
  for (const session of sessions) {
    if (
      !session.cwd ||
      session.cwd === '/workspace' ||
      sameWorkspace(session.cwd)
    )
      await connection.query(
        'UPDATE sessions SET project_id=$2,cwd=$3 WHERE id=$1',
        [session.id, managed.id, identity.display],
      )
  }
}

export class ServerAgentService {
  readonly options: ServerAgentOptions
  readonly manager: NativeAgentManager
  private readonly starts = new Map<string, Promise<void>>()
  private readonly leases = new Map<string, { release(): Promise<void> }>()
  private timer?: NodeJS.Timeout
  private closed = false
  private readonly unsubscribeModels: () => void
  constructor(options: ServerAgentOptions) {
    this.options = options
    const adapter =
      options.adapter ??
      new NativeHarnessAdapter({
        proxy: options.proxy,
        binding: async (owner) => {
          const binding = await this.binding(owner)
          if (!binding) throw new Error('Missing Server Agent binding')
          const row = await options.hub.connectorAllowed(
            String(binding.connector_id),
          )
          if (row.user_id !== owner)
            throw new Error('Invalid Server Agent ownership')
          return {
            connectorId: String(row.id),
            credentialFingerprint: String(row.token_hash),
          }
        },
        register: (id, connector) => options.hub.registerLocal(id, connector),
        ingest: async (id, notifications) => {
          const result = await options.hub.ingest(id, { notifications })
          if (
            (Array.isArray(result.rejected) && result.rejected.length) ||
            Number(result.accepted) !== notifications.length
          )
            throw new Error('Projection batch was not completely committed')
        },
        health: async (id, status) => {
          await options.db.query(
            "UPDATE device_runtimes SET status=$2,active=1,error_json=NULL,updated_at=$3 WHERE connector_id=$1 AND runtime_id='dsh'",
            [id, status, utcNow()],
          )
          await options.hub.changed(id)
        },
        attachment: options.attachment,
        business: options.business,
        platform: options.platform,
      })
    this.manager = new NativeAgentManager({
      rootDirectory: resolve(options.rootDirectory),
      adapter,
      startupTimeoutMs: 120_000,
      shutdownTimeoutMs: 15_000,
    })
    this.unsubscribeModels = options.models.onChanged((owner) => {
      if (adapter instanceof NativeHarnessAdapter) adapter.refreshModels(owner)
    })
  }
  private binding(owner: string): Promise<Row | undefined> {
    return this.options.db
      .query('SELECT * FROM server_agents WHERE owner_user_id=$1', [owner])
      .then((rows) => rows[0])
  }
  private workspace(owner: string): string {
    return join(
      resolve(this.options.rootDirectory),
      createHash('sha256').update(owner).digest('hex'),
      'workspace',
    )
  }
  async canPrepare(owner: string): Promise<boolean> {
    const account = await this.options.getAccount(owner)
    return (
      available(account) &&
      ['devices.manage', 'models.use', 'sessions.run'].every((permission) =>
        account!.permissions.includes(permission),
      )
    )
  }
  private async admitted(owner: string, id: string): Promise<boolean> {
    try {
      const row = await this.options.hub.connectorAllowed(id)
      const account = await this.options.getAccount(owner)
      return (
        row.user_id === owner &&
        available(account) &&
        ['models.use', 'sessions.run'].every((permission) =>
          account!.permissions.includes(permission),
        )
      )
    } catch {
      return false
    }
  }
  async view(owner: string): Promise<ServerAgentView> {
    const binding = await this.binding(owner)
    const empty: ServerAgentView = {
      status: 'stopped',
      connectorId: null,
      runtimeId: null,
      projectId: null,
      error: null,
    }
    if (!binding)
      return {
        ...empty,
        error: (await this.canPrepare(owner))
          ? null
          : 'server Agent execution permission required',
      }
    const base = {
      connectorId: String(binding.connector_id),
      runtimeId: String(binding.runtime_id),
      projectId: binding.project_id ? String(binding.project_id) : null,
    }
    if (!(await this.admitted(owner, base.connectorId)))
      return {
        ...base,
        status: 'stopped',
        error: 'server Agent connection is unavailable for this account',
      }
    const local = this.manager.status(owner)
    if (local.phase === 'ready' && this.options.hub.isOnline(base.connectorId))
      return { ...base, status: 'running', error: null }
    if (
      this.starts.has(owner) ||
      (binding.status === 'starting' &&
        Number(binding.lease_expires_at) > Date.now() / 1000)
    )
      return { ...base, status: 'starting', error: null }
    if (
      local.phase === 'error' ||
      local.phase === 'unavailable' ||
      binding.status === 'error'
    )
      return {
        ...base,
        status: 'error',
        error:
          local.message ??
          String(
            binding.error ?? 'server Harness is unavailable; retry preparation',
          ),
      }
    // A different API process can hold the native runtime lease; this process
    // must not claim ownership or start a second Host from stale presence.
    return { ...base, status: 'stopped', error: null }
  }
  private async ensureBinding(owner: string): Promise<Row> {
    return this.options.db.transaction(async (conn) => {
      await conn.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `server-agent-binding:${owner}`,
      ])
      const user = (
        await conn.query(
          'SELECT id,disabled,deleted_at FROM users WHERE id=$1 FOR UPDATE',
          [owner],
        )
      )[0]
      if (!user || user.disabled || user.deleted_at)
        throw new ApiError(403, 'account unavailable')
      let binding = (
        await conn.query(
          'SELECT * FROM server_agents WHERE owner_user_id=$1 FOR UPDATE',
          [owner],
        )
      )[0]
      const now = utcNow()
      const path = this.workspace(owner)
      const root = resolve(this.options.rootDirectory)
      await mkdir(root, { recursive: true, mode: 0o700 })
      const rootInfo = await lstat(root)
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
        throw new ApiError(409, 'native Agent root must be a real directory')
      const directory = join(path, '..')
      const directoryInfo = await lstat(directory).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null
          throw error
        },
      )
      if (
        directoryInfo &&
        (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
      )
        throw new ApiError(
          409,
          'native Agent directory must be an owned real directory',
        )
      let manifest: Record<string, unknown> | null = null
      try {
        const file = join(directory, 'native-runtime.json')
        const info = await lstat(file)
        if (info.isFile() && !info.isSymbolicLink() && info.size < 16384)
          manifest = JSON.parse(await readFile(file, 'utf8')) as Record<
            string,
            unknown
          >
      } catch {
        /* Missing or invalid provenance requires an explicit import. */
      }
      const ownedManifest = (connector: unknown) =>
        manifest?.version === 1 &&
        manifest.ownerUserId === owner &&
        manifest.connectorId === connector &&
        manifest.storage === 'native'
      if (!binding) {
        const digest = createHash('sha256')
          .update(owner)
          .digest('hex')
          .slice(0, 24)
        const connector = `conn_server_${digest}`
        if (
          directoryInfo &&
          (await readdir(directory)).length &&
          !ownedManifest(connector)
        )
          throw new ApiError(
            409,
            'existing native data does not match this server Agent binding',
          )
        const project = `proj_server_${digest}`
        const token = `cxt_${randomBytes(32).toString('base64url')}`
        const sealed = this.options.models.seal(
          token,
          `server-agent:${owner}:${connector}`,
        )
        await conn.query(
          "INSERT INTO connectors(id,user_id,name,connector_kind,executor_kind,device_os,status,token_hash,token_prefix,created_at,updated_at) VALUES($1,$2,'服务端 Agent','cli','server-agent',$3,'offline',$4,$5,$6,$6)",
          [
            connector,
            owner,
            process.platform,
            createHash('sha256').update(token).digest('hex'),
            token.slice(0, 12),
            now,
          ],
        )
        const names = new Set(
          (
            await conn.query('SELECT name FROM projects WHERE user_id=$1', [
              owner,
            ])
          ).map((row) => String(row.name)),
        )
        let name = '服务端工作区'
        let suffix = 1
        while (names.has(name)) name = `服务端工作区 (${suffix++})`
        await conn.query(
          'INSERT INTO projects(id,user_id,connector_id,name,workspace_path,workspace_key,manually_created,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,false,$7,$7)',
          [
            project,
            owner,
            connector,
            name,
            path,
            workspaceIdentity(path, process.platform).key,
            now,
          ],
        )
        binding = (
          await conn.query(
            "INSERT INTO server_agents(owner_user_id,connector_id,runtime_id,project_id,credential_ciphertext,created_at,updated_at) VALUES($1,$2,'dsh',$3,$4,$5,$5) RETURNING *",
            [owner, connector, project, sealed, now],
          )
        )[0]!
      } else {
        // A native process cannot silently replace a Docker volume with an empty
        // Home. An explicit, validated data import must create this marker first.
        if (!ownedManifest(binding.connector_id))
          throw new ApiError(
            409,
            '检测到旧版服务端 Agent 数据，尚未迁入 Node 运行环境。请先停止平台服务，备份并导出旧 Agent 数据，再运行 corepack.cmd yarn server:import-agent-data 完成导入；启动服务后重试。原有会话和文件不会被清空。',
          )
        await repairManagedProject(conn, binding, owner, path, now)
      }
      const id = String(binding.connector_id)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      if (!manifest)
        await writeFile(
          join(directory, 'native-runtime.json'),
          JSON.stringify({
            version: 1,
            storage: 'native',
            ownerUserId: owner,
            connectorId: id,
          }),
          { flag: 'wx', mode: 0o600 },
        )
      const description = {
        runtimeType: 'dsh',
        implementationType: 'dsh',
        displayName: 'DeepSeek Harness',
        present: true,
        available: true,
        instancePolicy: 'singleton',
        maxInstances: 1,
      }
      await conn.query(
        "INSERT INTO connector_runtime_types(connector_id,runtime_type,implementation_type,display_name,discovery_json,defaults_json,capabilities_json,metadata_json,instance_policy,max_instances,last_discovered_at,created_at,updated_at) VALUES($1,'dsh','dsh','DeepSeek Harness',$2,'{}','{}','{}','singleton',1,$3,$3,$3) ON CONFLICT(connector_id,runtime_type) DO NOTHING",
        [id, JSON.stringify(description), now],
      )
      await conn.query(
        "INSERT INTO device_runtimes(connector_id,runtime_id,runtime_type,name,name_key,config_json,active,status,created_at,updated_at) VALUES($1,'dsh','dsh','DeepSeek Harness','deepseek harness',$2,1,'starting',$3,$3) ON CONFLICT(connector_id,runtime_id) DO UPDATE SET config_json=EXCLUDED.config_json,active=1,status='starting',updated_at=EXCLUDED.updated_at",
        [id, JSON.stringify({ dshHome: join(path, '..', 'home') }), now],
      )
      return binding
    })
  }
  async prepare(owner: string): Promise<ServerAgentView> {
    if (this.closed) throw new ApiError(503, 'server is shutting down')
    if (!(await this.canPrepare(owner)))
      throw new ApiError(403, 'server Agent execution permission required')
    if (this.starts.has(owner)) return this.view(owner)
    const current = await this.view(owner)
    if (current.status === 'running') return current
    if (
      current.connectorId &&
      !(await this.admitted(owner, current.connectorId))
    )
      throw new ApiError(
        403,
        'server Agent connection is blocked or permissions were revoked',
      )
    const binding = await this.ensureBinding(owner)
    if (this.starts.has(owner)) return this.view(owner)
    const lease = await this.options.db.lease(`server-agent:${owner}`)
    if (!lease) return this.view(owner)
    this.leases.set(owner, lease)
    void lease.lost
      .then(async () => {
        if (this.leases.get(owner) !== lease) return
        await this.manager.stop(owner)
        await this.release(owner)
      })
      .catch(() => {})
    const leaseId = randomBytes(16).toString('hex')
    await this.options.db.query(
      "UPDATE server_agents SET status='starting',lease_id=$2,lease_expires_at=$3,error=NULL,updated_at=$4 WHERE owner_user_id=$1",
      [owner, leaseId, Math.floor(Date.now() / 1000) + 120, utcNow()],
    )
    const task = (async () => {
      try {
        if (!(await this.admitted(owner, String(binding.connector_id))))
          throw new Error('account authorization changed')
        const result = await this.manager.prepare(owner)
        const status = result.phase === 'ready' ? 'running' : 'error'
        await this.options.db.query(
          'UPDATE server_agents SET status=$3,error=$4,lease_expires_at=0,updated_at=$5 WHERE owner_user_id=$1 AND lease_id=$2',
          [
            owner,
            leaseId,
            status,
            result.phase === 'ready'
              ? null
              : (result.message ??
                'server Harness did not become ready; retry preparation'),
            utcNow(),
          ],
        )
        if (result.phase !== 'ready') await this.release(owner)
      } catch {
        await this.options.db
          .query(
            "UPDATE server_agents SET status='error',error='server Harness could not be prepared; retry preparation',lease_expires_at=0,updated_at=$3 WHERE owner_user_id=$1 AND lease_id=$2",
            [owner, leaseId, utcNow()],
          )
          .catch(() => {})
        await this.manager.stop(owner)
        await this.release(owner)
      }
    })().finally(() => this.starts.delete(owner))
    this.starts.set(owner, task)
    await this.options.audit(
      owner,
      'server-agent.prepare',
      String(binding.connector_id),
    )
    return this.view(owner)
  }
  private async release(owner: string): Promise<void> {
    const state = this.manager.status(owner)
    if (state.code === 'shutdown-failed' || state.code === 'startup-unresolved')
      return
    const lease = this.leases.get(owner)
    this.leases.delete(owner)
    await lease?.release()
  }
  async revoke(owner: string): Promise<void> {
    const binding = await this.binding(owner)
    if (!binding) return
    if (!(await this.admitted(owner, String(binding.connector_id)))) {
      const stopped = await this.manager.stop(owner)
      if (stopped.phase !== 'stopped') return
      await this.release(owner)
      await this.options.db.query(
        "UPDATE server_agents SET status='stopped',error=NULL,lease_expires_at=0,updated_at=$2 WHERE owner_user_id=$1",
        [owner, utcNow()],
      )
    }
  }
  startWatchdog(): void {
    if (this.timer) return
    let running = false
    this.timer = setInterval(() => {
      if (running || this.closed) return
      running = true
      void (async () => {
        for (const [owner] of this.leases) {
          const phase = this.manager.status(owner).phase
          if (
            phase === 'error' ||
            phase === 'stopped' ||
            phase === 'unavailable'
          ) {
            if (
              this.manager.status(owner).code === 'shutdown-failed' ||
              this.manager.status(owner).code === 'startup-unresolved'
            ) {
              await this.manager.stop(owner)
              if (this.manager.status(owner).phase !== 'stopped') continue
            }
            await this.release(owner)
            await this.options.db.query(
              "UPDATE server_agents SET status='error',lease_expires_at=0,error='server Harness process stopped; retry preparation',updated_at=$2 WHERE owner_user_id=$1",
              [owner, utcNow()],
            )
          } else await this.revoke(owner)
        }
      })()
        .catch(() => {})
        .finally(() => {
          running = false
        })
    }, 1000)
    this.timer.unref()
  }
  async close(): Promise<void> {
    this.closed = true
    this.unsubscribeModels()
    clearInterval(this.timer)
    await this.manager.close()
    await Promise.allSettled(this.starts.values())
    for (const owner of this.leases.keys()) {
      await this.options.db.query(
        "UPDATE server_agents SET status='stopped',lease_expires_at=0,updated_at=$2 WHERE owner_user_id=$1",
        [owner, utcNow()],
      )
      await this.release(owner)
    }
  }
}

export function registerServerAgentRoutes(
  router: ApiRouter,
  service: ServerAgentService,
): void {
  router.add('GET', '/server-agent', async (ctx) => ({
    agent: await service.view(ctx.account!.userId),
    serverTime: utcNow(),
  }))
  router.add(
    'POST',
    '/server-agent',
    async (ctx) => ({
      agent: await service.prepare(ctx.account!.userId),
      serverTime: utcNow(),
    }),
    { permission: 'devices.manage' },
  )
}
