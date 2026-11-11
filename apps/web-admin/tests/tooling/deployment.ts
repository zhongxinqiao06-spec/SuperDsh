/** 真实生产镜像生命周期验证；独立项目、合成账号、无外部模型调用。 */
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { composeEnvironment } from '../../scripts/configuration.ts'
import { appRoot, repositoryRoot } from '../../scripts/paths.ts'
import {
  assertOwned,
  docker,
  inspect,
  object,
  resources,
  validationLabel,
} from './deployment-docker.ts'

const { values } = parseArgs({
  options: {
    'backend-image': { type: 'string' },
    'fronted-image': { type: 'string' },
  },
})
assert(
  values['backend-image'],
  '必须显式指定已构建 backend 镜像，验证器不构建镜像',
)
assert(
  values['fronted-image'],
  '必须显式指定已构建 fronted 镜像，验证器不构建镜像',
)

const runId = `deployment-${Date.now()}-${randomUUID().slice(0, 8)}`
const project = `web-admin-${runId}`
const validationRoot = resolve(
  repositoryRoot,
  '.superdsh-work/web-admin-validation',
)
const directory = resolve(validationRoot, runId)
const generatedFiles = new Set<string>()
const services = [
  'postgres',
  'redis',
  'qdrant',
  'minio',
  'minio-init',
  'backend',
  'fronted',
]
const volumes = [
  'postgres-data',
  'redis-data',
  'qdrant-data',
  'minio-data',
  'runtime-data',
  'files-data',
  'config-data',
]
let composeArgs: string[] | undefined
let apiOrigin = ''
let token = ''
let managedProject: string | undefined
let assertions = 0
const completed: string[] = []
const imageIds: Record<string, string> = {}

function passed(message: string) {
  assertions += 1
  completed.push(message)
  console.log(`PASS ${message}`)
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  const address = server.address()
  assert(address && typeof address === 'object')
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  )
  return address.port
}

async function compose(args: string[], step: string, timeout = 180_000) {
  assert(composeArgs)
  return await docker([...composeArgs, ...args], step, timeout)
}

async function request(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${apiOrigin}${path}`, {
    method,
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(100_000),
  })
  if (!response.ok)
    throw new Error(`${method} ${path}: HTTP ${response.status}`)
  return object(await response.json())
}

async function ready() {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiOrigin}/api/health/ready`, {
        signal: AbortSignal.timeout(3_000),
      })
      if (response.ok) return
    } catch {
      /* 容器重启时拒绝连接属于有界就绪等待。 */
    }
    await delay(1_000)
  }
  throw new Error('Nginx 到后端就绪检查超时')
}

async function agent(expected: 'stopped' | 'running') {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const current = object((await request('/api/server-agent')).agent)
    if (current.status === expected) return current
    if (current.status === 'error')
      throw new Error('真实 DSH 准备进入 error 状态；需检查本轮容器脱敏诊断')
    await delay(500)
  }
  throw new Error(`真实 DSH 未达到 ${expected}`)
}

async function prepare() {
  await request('/api/server-agent', 'POST', {})
  const current = await agent('running')
  assert.equal(typeof current.runtimeId, 'string')
  assert.equal(typeof current.projectId, 'string')
  const projects = (await request('/api/projects')).projects
  assert(Array.isArray(projects))
  const matches = projects
    .map(object)
    .filter((item) => item.id === current.projectId)
  assert.equal(matches.length, 1, '真实准备必须持久化唯一受管工作区项目')
  assert.equal(matches[0]?.connectorId, current.connectorId)
  assert.equal(typeof matches[0]?.workspacePath, 'string')
  if (managedProject) assert.equal(current.projectId, managedProject)
  managedProject = String(current.projectId)
  // 目录来自运行中的固定 RuntimeBridge；不以 HTTP prepare 返回值冒充引擎就绪。
  await request('/api/runtime/catalogs/permissions')
}

async function stopAgent() {
  await request('/api/server-agent', 'DELETE')
  await agent('stopped')
  await compose(
    [
      'exec',
      '-T',
      'backend',
      'python',
      '-c',
      'from pathlib import Path; import os; live=[p for p in Path("/proc").glob("[0-9]*/cmdline") if p.parent.name != str(os.getpid()) and b"engine-adapter/dist/host.mjs" in p.read_bytes()]; assert not live, "DSH child remains"',
    ],
    '确认 DSH 子进程已回收',
  )
}

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

async function backendSecrets() {
  const id = await compose(['ps', '-q', 'backend'], '定位后端容器')
  const env = object((await inspect('container', id)).Config).Env
  assert(Array.isArray(env))
  const keys = ['WEB_ADMIN_SECRET=', 'WEB_ADMIN_ENCRYPTION_KEY=']
  const selected = env.filter(
    (item): item is string =>
      typeof item === 'string' && keys.some((key) => item.startsWith(key)),
  )
  assert.equal(selected.length, keys.length)
  return digest(selected.sort().join('\n'))
}

async function validateImageBoundaries() {
  await compose(
    [
      'exec',
      '-T',
      'backend',
      'python',
      '-c',
      'from pathlib import Path; roots=[Path("/app/apps/admin"),Path("/app/apps/web-admin/tests"),Path("/app/.superdsh-work"),Path("/app/node_modules")]; assert not any(p.exists() for p in roots); app=Path("/app/apps/web-admin/backend/app"); assert app.is_dir(); assert not any(p.suffix in {".js",".mjs",".ts"} or p.name.startswith("test_") for p in app.rglob("*")); assert Path("/app/apps/desktop/plugins/harness/node_modules").is_dir()',
    ],
    '检查 Python 镜像无旧管理端与测试目录',
  )
  await compose(
    [
      'exec',
      '-T',
      'fronted',
      'sh',
      '-c',
      'test -f /usr/share/nginx/html/index.html && test ! -e /app/apps/admin && test ! -e /app/apps/web-admin/tests && test ! -e /app/.superdsh-work && test ! -e /usr/share/nginx/html/tests',
    ],
    '检查 Nginx 镜像打包边界',
  )
  passed('运行镜像排除旧 admin、测试源码及根 node_modules；Python app 无 JS/TS')
}

async function validateOfficeRendering() {
  const source = await readFile(
    resolve(appRoot, 'tests/fixtures/deployment_office.py'),
    'utf8',
  )
  // 测试仅通过命令参数运行；源文件和产物不写入镜像的 /app 目录。
  await compose(
    ['exec', '-T', 'backend', 'python', '-c', source],
    '验证生产镜像实际 Office 渲染与简体中文字体',
    120_000,
  )
  passed(
    '生产镜像 LibreOffice 真实渲染 Word、演示与表格，中文/字体/PDF/缩略图通过',
  )
}

async function rejectUnimplementedWebSocket() {
  // 未登记地址必须被拒绝；业务 WS 另用票据和实际帧验证。
  await new Promise<void>((done, reject) => {
    const socket = new WebSocket(
      `${apiOrigin.replace('http:', 'ws:')}/ws/runtime`,
    )
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error('未知 WS 未及时拒绝'))
    }, 10_000)
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer)
        socket.close()
        reject(new Error('未实现的 WS 意外建立'))
      },
      { once: true },
    )
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer)
        done()
      },
      { once: true },
    )
  })
  passed('Nginx 拒绝未登记 WS Upgrade')
}

async function validateDashboardSocket() {
  const clientId = 'deployment-contract'
  const issued = await request('/api/ws-ticket', 'POST', {
    clientId,
    scope: { dashboard: true },
  })
  assert.equal(typeof issued.ticket, 'string')
  await new Promise<void>((done, reject) => {
    const socket = new WebSocket(
      `${apiOrigin.replace('http:', 'ws:')}/api/dashboard/ws?${new URLSearchParams({ clientId, ticket: String(issued.ticket) })}`,
    )
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error('设备订阅未返回真实帧'))
    }, 10_000)
    socket.addEventListener(
      'message',
      (event) => {
        try {
          const frame = object(JSON.parse(String(event.data)))
          assert.equal(frame.type, 'dashboard.snapshot')
          for (const key of ['connectors', 'projects', 'sessions', 'runtimes'])
            assert(Array.isArray(frame[key]), `缺少旧客户端首帧字段 ${key}`)
          assert(frame.sessionPages && typeof frame.serverTime === 'string')
          clearTimeout(timer)
          socket.close()
          done()
        } catch (error) {
          clearTimeout(timer)
          socket.close()
          reject(error)
        }
      },
      { once: true },
    )
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer)
        reject(new Error('设备订阅 WS 连接失败'))
      },
      { once: true },
    )
  })
  passed('Nginx 真实业务 WS：一次性票据、认证与完整 dashboard.snapshot 首帧')
}

async function validateWorkspaceOperations() {
  // 设备列表是只读能力，只有显式准备才建立固定 DSH 身份及工作区。
  await prepare()
  const inventory = await request('/api/connectors')
  assert(Array.isArray(inventory.connectors))
  const native = inventory.connectors
    .map(object)
    .find((value) => value.executorKind === 'server-agent')
  assert(native && typeof native.id === 'string')
  const prefix = `/api/connectors/${encodeURIComponent(native.id)}`
  const content = '生产镜像中的合成文件正文'
  await request(prefix + '/fs/write', 'POST', {
    path: 'deployment-check.txt',
    content,
  })
  assert.equal(
    (
      await request(prefix + '/fs/readText', 'POST', {
        path: 'deployment-check.txt',
      })
    ).content,
    content,
  )
  const issued = await request(prefix + '/fs/preview-token', 'POST', {
    path: 'deployment-check.txt',
  })
  const access = await request('/api/connectors/fs/preview-session', 'POST', {
    previewToken: issued.previewToken,
  })
  assert.equal(
    (
      await request('/api/connectors/fs/preview/readText', 'POST', {
        previewAccessToken: access.previewAccessToken,
      })
    ).content,
    content,
  )
  const prepared = object(
    (
      await request(prefix + '/fs/read', 'POST', {
        path: 'deployment-check.txt',
      })
    ).result,
  )
  assert.equal(typeof prepared.downloadUrl, 'string')
  const response = await fetch(apiOrigin + prepared.downloadUrl, {
    signal: AbortSignal.timeout(10_000),
  })
  assert(response.ok)
  const data = Buffer.from(await response.arrayBuffer())
  assert.equal(createHash('sha256').update(data).digest('hex'), prepared.sha256)
  assert.equal(data.toString(), content)
  const shell = object(
    (
      await request(prefix + '/shell/exec', 'POST', {
        command: 'printf DEPLOYMENT_SHELL_OK',
        operationId: 'deployment-shell',
      })
    ).result,
  )
  assert.equal(shell.stdout, 'DEPLOYMENT_SHELL_OK')
  const terminal = object(
    (await request(prefix + '/terminals', 'POST', { name: '容器伪终端' }))
      .terminal,
  )
  const endpoint = prefix + '/terminals/' + String(terminal.id)
  await request(endpoint + '/write', 'POST', {
    // 将标记拆开，避免终端回显命令本身被误认为 shell 已执行。
    data: "printf 'DEPLOYMENT_''PTY_OK\\n'\n",
  })
  let found = false
  for (let attempt = 0; attempt < 30; attempt++) {
    const snapshot = await request(endpoint + '/snapshot')
    if (String(snapshot.data).includes('DEPLOYMENT_PTY_OK')) {
      found = true
      break
    }
    await delay(100)
  }
  assert(found, '容器真实 PTY 未返回输出')
  await request(endpoint, 'DELETE')
  await compose(
    [
      'exec',
      '-T',
      'backend',
      'python',
      '-c',
      'from pathlib import Path; import sys; assert sys.pycache_prefix == "/data/runtime/.superdsh-work/pycache"; assert not any(Path("/app/apps/web-admin/backend").rglob("*.pyc")); assert not Path("/app/.superdsh-work").exists()',
    ],
    '确认运行缓存未污染源码目录',
  )
  passed('生产镜像真实文件写读/票据预览/下载摘要/Shell 与 POSIX PTY 创建关闭')
}

async function cleanup() {
  if (composeArgs) {
    await assertOwned(project, runId)
    await compose(
      ['down', '--volumes', '--remove-orphans', '--timeout', '90'],
      '清理本轮容器与卷',
    )
    for (const kind of ['container', 'volume', 'network'] as const)
      assert.equal(
        (await resources(kind, project)).length,
        0,
        `残留本轮 ${kind}`,
      )
  }
  // 仅删除本次显式创建并登记的普通文件；不递归清理，也不触碰此前遭拒绝的目录。
  for (const file of generatedFiles) {
    const child = relative(directory, file)
    assert(child && !isAbsolute(child) && !child.startsWith(`..${sep}`))
    try {
      const info = await lstat(file)
      assert(info.isFile() && !info.isSymbolicLink(), '拒绝清理非本轮普通文件')
      await unlink(file)
    } catch (error) {
      if (!(
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error
    }
  }
  console.log(
    `CLEAN 本轮容器、命名卷、网络及合成密钥文件已清理；空目录保留: ${directory}`,
  )
}

async function validate() {
  for (const kind of ['container', 'volume', 'network'] as const)
    assert.equal((await resources(kind, project)).length, 0, '拒绝复用已有项目')
  await mkdir(directory, { recursive: true })
  const imageId = async (name: string) => {
    const id = await docker(
      ['image', 'inspect', '--format', '{{.Id}}', name],
      '解析显式镜像 ID',
    )
    assert.match(id, /^sha256:[a-f0-9]{64}$/u)
    return id
  }
  const backendImage = await imageId(values['backend-image']!)
  const frontedImage = await imageId(values['fronted-image']!)
  imageIds.backend = backendImage
  imageIds.fronted = frontedImage
  console.log(`IMAGE backend=${backendImage} fronted=${frontedImage}`)
  const port = await freePort()
  apiOrigin = `http://127.0.0.1:${port}`
  const first = await composeEnvironment(
    'production',
    directory,
    project,
    resolve(directory, 'model-defaults.json'),
  )
  generatedFiles.add(first.configPath)
  generatedFiles.add(first.envFile)
  const settings = object(JSON.parse(await readFile(first.configPath, 'utf8')))
  const username = `deployment_${randomBytes(5).toString('hex')}`
  const password = `Synthetic-${randomBytes(24).toString('base64url')}!`
  settings.initialAdmin = { username, password, displayName: '部署验证管理员' }
  const ports = object(settings.ports)
  ports.frontedPort = port
  await writeFile(first.configPath, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600,
  })
  const loaded = await composeEnvironment(
    'production',
    directory,
    project,
    resolve(directory, 'model-defaults.json'),
  )
  const configHash = digest(await readFile(loaded.configPath, 'utf8'))
  const override = resolve(directory, 'config/validation.compose.yml')
  const labels = { [validationLabel]: runId }
  // JSON 为合法 YAML；ports 使用 Compose 的 !override，确保不继承宿主机默认开放端口。
  const serviceLines = services.map((name) => {
    const value: Record<string, unknown> = { labels }
    if (name === 'backend') {
      value.image = backendImage
      value.environment = {
        WEB_ADMIN_PUBLIC_ORIGIN: apiOrigin,
        WEB_ADMIN_ALLOWED_ORIGINS: JSON.stringify([apiOrigin]),
      }
    }
    if (name === 'fronted') value.image = frontedImage
    return `  ${name}:\n    ${Object.entries(value)
      .map(([key, item]) => `${key}: ${JSON.stringify(item)}`)
      .join(
        '\n    ',
      )}${name === 'fronted' ? `\n    ports: !override ["127.0.0.1:${port}:8080"]` : ''}`
  })
  await writeFile(
    override,
    `name: ${project}\nservices:\n${serviceLines.join('\n')}\nvolumes:\n${volumes.map((name) => `  ${name}: ${JSON.stringify({ name: `${project}-${name}`, labels })}`).join('\n')}\nnetworks:\n  default: ${JSON.stringify({ name: `${project}-default`, labels })}\n`,
    { flag: 'wx' },
  )
  generatedFiles.add(override)
  composeArgs = [
    'compose',
    '--project-name',
    project,
    '--env-file',
    loaded.envFile,
    '-f',
    resolve(repositoryRoot, 'compose.web-admin.yml'),
    '-f',
    override,
  ]
  const configuration = object(
    JSON.parse(
      await compose(['config', '--format', 'json'], '核验隔离 Compose 配置'),
    ),
  )
  assert.equal(configuration.name, project)
  const configuredServices = object(configuration.services)
  assert.deepEqual(Object.keys(configuredServices).sort(), [...services].sort())
  for (const value of Object.values(configuredServices)) {
    const service = object(value)
    assert.equal(object(service.labels)[validationLabel], runId)
    if (Array.isArray(service.volumes))
      for (const mount of service.volumes)
        assert.equal(object(mount).type, 'volume', '生产验证不允许 host bind')
  }
  passed('独立 Compose project、端口、命名卷与双标签隔离')
  await compose(
    [
      'up',
      '-d',
      '--no-build',
      '--pull',
      'never',
      '--wait',
      '--wait-timeout',
      '180',
    ],
    '启动固定生产镜像',
    240_000,
  )
  await ready()
  assert(
    (await fetch(`${apiOrigin}/`)).headers
      .get('content-type')
      ?.includes('text/html'),
  )
  await request('/api/health/live')
  passed('真实 Nginx 页面、存活与全依赖就绪')
  await validateImageBoundaries()
  await validateOfficeRendering()
  await rejectUnimplementedWebSocket()

  assert.equal((await request('/api/auth/config')).needsBootstrap, false)
  let owner: string | undefined
  const login = async () => {
    token = ''
    const result = await request('/api/auth/login', 'POST', {
      identifier: username,
      password,
      clientType: 'native',
    })
    assert.equal(typeof result.userId, 'string')
    if (owner) assert.equal(result.userId, owner)
    else owner = String(result.userId)
    assert.equal(typeof result.accessToken, 'string')
    token = result.accessToken as string
    assert.equal((await request('/api/auth/config')).needsBootstrap, false)
  }
  await login()
  await agent('stopped')
  assert.deepEqual((await request('/api/projects')).projects, [])
  passed('配置自动创建管理员、真实登录和管理读取不启动 DSH 或创建受管项目')
  await validateDashboardSocket()
  await validateWorkspaceOperations()
  // 兼容路径从唯一映射读取；不把本次身份与 prepare 覆盖扩展为全部旧 API 完成。
  const compatibility = object(
    JSON.parse(
      await readFile(
        resolve(appRoot, 'deployment/compatibility-routes.json'),
        'utf8',
      ),
    ),
  )
  assert(Array.isArray(compatibility.routes))
  const route = compatibility.routes
    .map(object)
    .find((item) => item.canonical === '/api/auth/me' && item.method === 'GET')
  assert(route && typeof route.legacy === 'string')
  assert.equal((await request(route.legacy)).userId, owner)
  passed('声明式旧身份入口与无版本入口返回同一账号（非全部旧 API 验收）')
  await prepare()
  await stopAgent()
  passed('真实固定 DSH prepare、唯一受管项目、RuntimeBridge 目录查询与关闭回收')
  const secretHash = await backendSecrets()

  const backup = `${loaded.configPath}.validation-backup`
  generatedFiles.add(backup)
  await rename(loaded.configPath, backup)
  try {
    await assert.rejects(
      composeEnvironment(
        'production',
        directory,
        project,
        resolve(directory, 'model-defaults.json'),
      ),
      /发现已有 Compose 数据卷但缺少配置/u,
    )
  } finally {
    await rename(backup, loaded.configPath)
  }
  passed('命名卷存在但配置丢失时拒绝生成新密钥')

  await prepare()
  await compose(
    ['restart', '--timeout', '90', 'backend', 'fronted'],
    'DSH 运行期间重启后端与反代',
  )
  await ready()
  await login()
  await agent('stopped')
  assert.equal(await backendSecrets(), secretHash)
  await prepare()
  await stopAgent()
  passed('运行中重启清理 DSH，账号与密钥保持，可重新准备且无残留执行围栏')

  await composeEnvironment(
    'production',
    directory,
    project,
    resolve(directory, 'model-defaults.json'),
  )
  assert.equal(digest(await readFile(loaded.configPath, 'utf8')), configHash)
  await compose(['stop', '--timeout', '90'], '停止本轮部署')
  for (const id of await resources('container', project))
    assert.equal(object((await inspect('container', id)).State).Running, false)
  await compose(
    [
      'up',
      '-d',
      '--no-build',
      '--pull',
      'never',
      '--wait',
      '--wait-timeout',
      '180',
    ],
    '重新启动本轮部署',
    240_000,
  )
  await ready()
  await login()
  await agent('stopped')
  assert.equal(await backendSecrets(), secretHash)
  assert.equal(digest(await readFile(loaded.configPath, 'utf8')), configHash)
  await prepare()
  await stopAgent()
  passed('stop/start 持久化账号及配置，恢复后真实 DSH 仍可工作')
  console.log(
    `RESULT ${assertions} 项真实 Docker 生命周期检查通过；未调用外部模型，未宣称完整客户端兼容`,
  )
}

let failed = false
let validationPassed = false
let cleanupPassed = false
const failures: string[] = []
try {
  await validate()
  validationPassed = true
} catch (error) {
  failed = true
  const message = error instanceof Error ? error.message : '部署验证失败'
  failures.push(message)
  console.error(message)
} finally {
  try {
    await cleanup()
    cleanupPassed = true
  } catch (error) {
    failed = true
    failures.push(error instanceof Error ? error.message : '资源清理失败')
    console.error(
      `CLEANUP FAILED: ${error instanceof Error ? error.message : '未知错误'}；本轮项目 ${project}，目录 ${directory}`,
    )
  }
  // 只保留无凭据的断言、镜像摘要和清理结果，合成配置与运行卷已由上方单独回收。
  await mkdir(directory, { recursive: true })
  await writeFile(
    resolve(directory, 'results.json'),
    JSON.stringify(
      {
        runId,
        generatedAt: new Date().toISOString(),
        scope: 'isolated-production-images-and-lifecycle',
        fullParity: false,
        imageIds,
        validationPassed,
        cleanupPassed,
        passed: validationPassed && cleanupPassed,
        completed,
        failures,
      },
      null,
      2,
    ) + '\n',
  )
}
if (failed) process.exitCode = 1
