import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import test from 'node:test'
import JSZip from 'jszip'
import { withTestDatabase } from './support/database.mjs'
import { IdentityService } from '../identity/service.ts'
import { ExtensionService } from '../extensions/service.ts'
import { AgentResourceService } from '../agents/resources.ts'

async function setup(t) {
  const db = await withTestDatabase(t)
  const identity = new IdentityService(db, { secret: 'synthetic-extensions' })
  await identity.seedBuiltinRoles()
  const account = await identity.createUser(
    {
      username: 'extensionmanager',
      password: 'synthetic-password',
      displayName: 'Manager',
    },
    { role: 'admin' },
  )
  const directory = await mkdtemp(join(tmpdir(), 'superdsh-extension-db-'))
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  })
  const audit = identity.audit.bind(identity)
  const extensions = new ExtensionService({
    db,
    directory,
    encryptionKey: randomBytes(32).toString('base64url'),
    allowedOrigins: '',
    audit,
  })
  const resources = new AgentResourceService({ db, audit, extensions })
  return { db, account, extensions, resources }
}
async function zip(version = '1.0.0', fail = false) {
  const zip = new JSZip()
  zip.file(
    'superdsh-extension.json',
    JSON.stringify({
      schemaVersion: 1,
      id: 'test.dynamic',
      name: '测试包',
      version,
      license: 'MIT',
      description: '临时测试',
      runtime: 'node',
      entrypoint: 'index.mjs',
      tools: [
        {
          id: 'echo',
          name: '文档工具',
          description: '隔离测试',
          mode: 'action',
          inputSchema: {
            type: 'object',
            properties: { leak: { type: 'boolean' } },
            additionalProperties: false,
          },
          configurationSchema: {
            type: 'object',
            properties: { key: { type: 'string', writeOnly: true } },
            additionalProperties: false,
          },
          permissions: ['sessions.run'],
          artifactTypes: ['text/plain'],
          timeoutSeconds: 15,
        },
      ],
    }),
  )
  zip.file(
    'index.mjs',
    `let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{const r=JSON.parse(s);process.stdout.write(JSON.stringify(r.operation==='health'?{ok:${!fail}}:r.arguments.leak?{artifacts:[{name:'leak.txt',contentBase64:Buffer.from(r.configuration.key).toString('base64')}]}:{version:'${version}',result:r.configuration.key,context:r.context}))})`,
  )
  return zip.generateAsync({ type: 'base64' })
}
async function install(f, version = '1.0.0', revision) {
  return f.extensions.install(
    f.account,
    { contentBase64: await zip(version), revision },
    new AbortController().signal,
  )
}
const config = (installed, key) => ({
  name: '可配置工具',
  description: '测试',
  enabled: true,
  settings: { key },
  implementation: {
    sourceId: installed.id,
    version: installed.version,
    digest: installed.digest,
    toolId: 'echo',
  },
})

test('immutable tool versions encrypt credentials and restore without exposing them in resource history', async (t) => {
  const f = await setup(t),
    installed = await install(f)
  const first = await f.resources.saveTool(
    f.account,
    config(installed, 'synthetic-first-key'),
  )
  const second = await f.resources.saveTool(
    f.account,
    { ...config(installed, 'synthetic-second-key'), version: 1 },
    first.id,
  )
  assert.equal(second.version, 2)
  assert.equal(
    (await f.extensions.secrets(f.account.userId, first.id, 1)).key,
    'synthetic-first-key',
  )
  const history = await f.resources.history(
    'tools',
    f.account,
    first.id,
    new URLSearchParams(),
  )
  assert.doesNotMatch(
    JSON.stringify(history),
    /synthetic-first-key|synthetic-second-key/,
  )
  const stored = await f.db.query(
    'SELECT encrypted_json FROM agent_tool_secrets',
  )
  assert.doesNotMatch(
    JSON.stringify(stored),
    /synthetic-first-key|synthetic-second-key/,
  )
  const restored = await f.resources.restore('tools', f.account, first.id, {
    sourceVersion: 1,
    version: 2,
  })
  assert.equal(restored.version, 3)
  assert.equal(
    (await f.extensions.secrets(f.account.userId, first.id, 3)).key,
    'synthetic-first-key',
  )
  const signal = new AbortController().signal
  const result = await f.extensions.invoke(
    first.implementation,
    {},
    { key: 'synthetic-first-key' },
    signal,
    { sessionId: 'test-session', bindingVersion: 1, sources: [] },
  )
  assert.equal(result.result, '[已隐藏凭据]')
  assert.equal(result.context.sessionId, 'test-session')
  await assert.rejects(
    () =>
      f.extensions.invoke(
        first.implementation,
        { leak: true },
        { key: 'synthetic-first-key' },
        signal,
      ),
    (error) => error.status === 502,
  )
})

test('package upgrades preserve frozen implementations; source disable and installation permission take effect', async (t) => {
  const f = await setup(t),
    first = await install(f)
  const ref = {
    sourceId: first.id,
    version: first.version,
    digest: first.digest,
    toolId: 'echo',
  }
  await assert.rejects(
    () =>
      f.extensions.install(
        {
          ...f.account,
          permissions: f.account.permissions.filter(
            (p) => p !== 'extensions.manage',
          ),
        },
        { contentBase64: '' },
        new AbortController().signal,
      ),
    (error) => error.status === 403,
  )
  await f.extensions.install(
    f.account,
    { contentBase64: await zip('2.0.0'), revision: 1 },
    new AbortController().signal,
  )
  assert.equal(
    (await f.extensions.invoke(ref, {}, {}, new AbortController().signal))
      .version,
    '1.0.0',
  )
  await assert.rejects(
    async () =>
      f.extensions.install(
        f.account,
        { contentBase64: await zip('3.0.0', true), revision: 2 },
        new AbortController().signal,
      ),
    /健康/,
  )
  assert.equal(
    (await f.extensions.list(f.account)).find((s) => s.id === first.id)
      .activeVersion,
    '2.0.0',
  )
  await f.extensions.update(
    f.account,
    first.id,
    { revision: 2, enabled: false, activeVersion: '2.0.0' },
    new AbortController().signal,
  )
  await assert.rejects(
    () => f.extensions.invoke(ref, {}, {}, new AbortController().signal),
    (error) => error.status === 403,
  )
})
