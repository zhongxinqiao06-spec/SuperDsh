/** 启动素材闭环的隔离人工浏览器验收，结束文件触发本轮服务、数据库与文件清理。 */
import { createServer } from 'node:net'
import { delimiter, resolve } from 'node:path'
import { createWriteStream } from 'node:fs'
import { access, mkdir, writeFile } from 'node:fs/promises'
import type { ChildProcess } from 'node:child_process'
import { finished } from 'node:stream/promises'
import { validationEnvironment } from './validation.ts'
import { backendRoot, repositoryRoot } from '../../scripts/paths.ts'
import { launch, run, stop } from '../../scripts/processes.ts'
import {
  pythonEnvironment,
  pythonExecutable,
} from '../../scripts/python-environment.ts'

async function freePort(): Promise<number> {
  const server = createServer()
  return new Promise((done, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string')
        return reject(new Error('端口分配失败'))
      server.close((error) => (error ? reject(error) : done(address.port)))
    })
  })
}

const context = await validationEnvironment()
const backendPort = await freePort(),
  frontedPort = await freePort()
const api = `http://127.0.0.1:${backendPort}`
const base = `http://localhost:${frontedPort}`
const password = 'Synthetic-library-review-only!'
const environment = pythonEnvironment({
  ...context.environment,
  PYTHONPATH: [
    backendRoot,
    resolve(repositoryRoot, 'apps/web-admin/tests'),
  ].join(delimiter),
  WEB_ADMIN_PUBLIC_ORIGIN: base,
  WEB_ADMIN_ALLOWED_ORIGINS: JSON.stringify([base]),
  WEB_ADMIN_API_ORIGIN: api,
  WEB_ADMIN_FRONTED_PORT: String(frontedPort),
  WEB_ADMIN_INITIAL_ADMIN_USERNAME: 'library-review',
  WEB_ADMIN_INITIAL_ADMIN_PASSWORD: password,
  WEB_ADMIN_INITIAL_ADMIN_DISPLAY_NAME: '素材闭环验收',
})
const children: ChildProcess[] = []
const logs: ReturnType<typeof createWriteStream>[] = []
let shutdown = false
process.once('SIGINT', () => {
  shutdown = true
})
process.once('SIGTERM', () => {
  shutdown = true
})
async function waitReady(url: string) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (children.some((child) => child.exitCode !== null))
      throw new Error('验收服务提前退出')
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return
    } catch {
      /* 有限等待 */
    }
    await new Promise((done) => setTimeout(done, 500))
  }
  throw new Error('验收服务未就绪')
}
try {
  await run(
    pythonExecutable(),
    [
      '-m',
      'alembic',
      '-c',
      resolve(backendRoot, 'alembic.ini'),
      'upgrade',
      'head',
    ],
    { cwd: backendRoot, env: environment },
  )
  for (const [name, executable, args] of [
    [
      'backend',
      pythonExecutable(),
      [
        '-m',
        'app.launcher',
        '--host',
        '127.0.0.1',
        '--port',
        String(backendPort),
      ],
    ],
    [
      'fronted',
      process.execPath,
      [
        'node_modules/vite/bin/vite.js',
        'preview',
        '--config',
        'apps/web-admin/fronted/vite.config.ts',
        '--host',
        'localhost',
        '--port',
        String(frontedPort),
      ],
    ],
  ] as const) {
    const log = createWriteStream(resolve(context.directory, name + '.log'))
    logs.push(log)
    const child = launch(executable, [...args], {
      env: environment,
      stdio: [name === 'backend' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    child.stdout?.pipe(log, { end: false })
    child.stderr?.pipe(log, { end: false })
  }
  await waitReady(api + '/api/health/ready')
  await waitReady(base)
  let token = ''
  async function call(path: string, body?: unknown, method = 'POST') {
    const response = await fetch(api + '/api' + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok)
      throw new Error(`${path}: ${response.status} ${await response.text()}`)
    return response.json()
  }
  token = (
    await call('/auth/login', {
      identifier: 'library-review',
      password,
      clientType: 'native',
    })
  ).accessToken
  const first = await call('/studio/projects', {
    title: '小白的太空旅行 · 隔离验收',
    aspectWidth: 9,
    aspectHeight: 16,
    targetDurationMs: 10000,
  })
  const second = await call('/studio/projects', {
    title: '小白的新旅程 · 隔离验收',
    aspectWidth: 9,
    aspectHeight: 16,
    targetDurationMs: 10000,
  })
  const hero = await call('/studio/assets', {
    project: first.id,
    kind: 'character',
    name: '小白',
    description: '白色短圆耳朵，原造型；收藏与新作品修改不应改变此版本。',
    voice: 'synthetic-voice',
  })
  await call('/studio/assets', {
    kind: 'scene',
    name: '森林 · 日景',
    description: '明亮森林、低矮灌木、暖色阳光',
  })
  await call('/studio/assets', {
    kind: 'scene',
    name: '森林 · 雨夜',
    description: '雨滴、深蓝树林与水面倒影',
  })
  await call('/studio/assets', {
    kind: 'prop',
    name: '星星电池',
    description: '金色五角星形，中心发光',
  })
  const opened = await call('/studio/projects/' + first.id, undefined, 'GET')
  await call(
    '/studio/projects/' + first.id,
    {
      revision: opened.revision,
      document: {
        assets: [hero.id],
        script: '小白带着星星电池进入森林。',
        scenes: [{ id: 'forest-story', title: '进入森林' }],
        shots: [
          {
            id: 'forest-shot',
            sceneId: 'forest-story',
            action: '小白举起星星电池，进入森林。',
            duration: 5000,
            references: [hero.id],
            lines: [
              {
                id: 'hero-line',
                role: hero.id,
                text: '出发吧。',
                voice: 'synthetic-voice',
              },
            ],
          },
        ],
      },
      label: '合成验收初始工程',
    },
    'PUT',
  )
  const evidence = resolve(
    repositoryRoot,
    '.superdsh-work/web-admin-validation/library-implementation-20261118',
  )
  // 比较场景预置两个固定版本，人工验收采用动作不会触发模型或改动用户作品。
  const collection = await call('/studio/library/collections', {
    sourceVersionId: hero.id,
    requestKey: 'review-collect',
    mode: 'new',
  })
  await call('/studio/projects/' + second.id + '/library-imports', {
    sourceVersionId: collection.asset.id,
    expectedRevision: second.revision,
    requestKey: 'review-import',
  })
  await call('/studio/assets', {
    kind: 'character',
    name: '小白',
    description: '白色短圆耳朵，新增红领巾；声音保持原样。',
    voice: 'synthetic-voice',
    parent: collection.asset.id,
  })
  await mkdir(evidence, { recursive: true })
  const result = {
    base,
    api,
    project: first.id,
    secondProject: second.id,
    directory: context.directory,
    username: 'library-review',
    password,
  }
  await writeFile(
    resolve(evidence, 'review-server.json'),
    JSON.stringify(result, null, 2),
  )
  console.log('REVIEW_READY ' + JSON.stringify(result))
  const deadline = Date.now() + 60 * 60 * 1000
  while (!shutdown && Date.now() < deadline) {
    if (children.some((child) => child.exitCode !== null))
      throw new Error('验收服务提前退出')
    try {
      await access(resolve(context.directory, 'stop'))
      break
    } catch {
      /* 仅观察本轮结束标记 */
    }
    await new Promise((done) => setTimeout(done, 500))
  }
} finally {
  try {
    for (const child of children.reverse()) await stop(child)
  } finally {
    for (const log of logs) {
      log.end()
      await finished(log)
    }
    await context.cleanup()
  }
}
