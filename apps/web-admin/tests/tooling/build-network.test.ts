import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { delimiter, dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { backendRoot, repositoryRoot } from '../../scripts/paths.ts'

/** 在隔离目录执行真实 POSIX 脚本，不改宿主机源和网络设置。 */
test('APT 镜像只替换官方地址，保留签名并拒绝无界超时', async () => {
  const directory = await fixture()
  try {
    const root = resolve(directory, 'apt')
    await mkdir(resolve(root, 'apt.conf.d'), { recursive: true })
    await mkdir(resolve(root, 'sources.list.d'), { recursive: true })
    const source = resolve(root, 'sources.list.d/debian.sources')
    const original = [
      'Types: deb',
      'URIs: http://deb.debian.org/debian',
      'Suites: bookworm bookworm-updates',
      'Components: main',
      'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg',
      '',
      'Types: deb',
      'URIs: https://deb.debian.org/debian-security',
      'Suites: bookworm-security',
      'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg',
      '',
      'URIs: https://unrelated.example/repository',
      '',
    ].join('\n')
    await writeFile(source, original)
    const shell = posixShell()
    const run = (overrides: NodeJS.ProcessEnv = {}) =>
      spawnSync(
        shell,
        [
          resolve(repositoryRoot, 'apps/web-admin/deployment/configure-apt.sh'),
          root,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${dirname(shell)}${delimiter}${process.env.PATH ?? ''}`,
            APT_MIRROR: '',
            BUILD_HTTP_TIMEOUT: '120',
            BUILD_HTTP_RETRIES: '3',
            BUILD_DOWNLOAD_TIMEOUT: '1800',
            ...overrides,
          },
          timeout: 10_000,
        },
      )
    const unchanged = run()
    assert.equal(unchanged.status, 0, unchanged.stderr)
    assert.equal(await readFile(source, 'utf8'), original)
    assert.equal(run({ APT_MIRROR: 'https://mirror.example/' }).status, 0)
    assert.equal(
      await readFile(source, 'utf8'),
      original
        .replace(
          'http://deb.debian.org/debian',
          'https://mirror.example/debian',
        )
        .replace(
          'https://deb.debian.org/debian-security',
          'https://mirror.example/debian-security',
        ),
    )
    const configuration = await readFile(
      resolve(root, 'apt.conf.d/80superdsh-network'),
      'utf8',
    )
    assert.match(configuration, /Acquire::Retries "3"/u)
    assert.match(configuration, /Acquire::https::Timeout "120"/u)
    for (const invalid of [
      { APT_MIRROR: 'https://name:secret@mirror.example' },
      { APT_MIRROR: 'https://mirror.example/$(touch escaped)' },
      { BUILD_HTTP_TIMEOUT: '0' },
      { BUILD_HTTP_RETRIES: '11' },
      { BUILD_DOWNLOAD_TIMEOUT: '0' },
    ]) {
      assert.equal(run(invalid).status, 2)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

/** 用隔离假命令记录实际子进程参数，验证安装约束而不联网、不安装或改依赖缓存。 */
test('Yarn 安装单独约束资源，保留镜像、immutable 和可配置边界', async () => {
  const directory = await fixture()
  try {
    const shell = posixShell()
    const executable = resolve(directory, 'corepack')
    const output = resolve(directory, 'captured.txt')
    const script = [
      '#!/bin/sh',
      'printf "%s\\n" "$NODE_OPTIONS" "$YARN_NETWORK_CONCURRENCY" "$YARN_TASK_POOL_CONCURRENCY" "$YARN_TASK_POOL_MODE" "${YARN_NPM_REGISTRY_SERVER:-}" "${COREPACK_NPM_REGISTRY:-}" > "$TEST_OUTPUT"',
      'printf "%s\\n" "$@" >> "$TEST_OUTPUT"',
      '',
    ].join('\n')
    await writeFile(executable, script)
    await chmod(executable, 0o755)
    const run = (overrides: NodeJS.ProcessEnv = {}) =>
      spawnSync(
        shell,
        [
          resolve(
            repositoryRoot,
            'apps/web-admin/deployment/install-node-dependencies.sh',
          ),
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: [directory, dirname(shell), process.env.PATH ?? ''].join(
              delimiter,
            ),
            TEST_OUTPUT: output,
            NODE_OPTIONS: '--max-old-space-size=3072',
            YARN_NETWORK_CONCURRENCY: '2',
            YARN_TASK_POOL_CONCURRENCY: '24',
            YARN_TASK_POOL_MODE: 'workers',
            YARN_NPM_REGISTRY_SERVER: '',
            COREPACK_NPM_REGISTRY: '',
            BUILD_YARN_NETWORK_CONCURRENCY: '',
            BUILD_YARN_TASK_POOL_CONCURRENCY: '',
            BUILD_YARN_TASK_POOL_MODE: '',
            BUILD_YARN_HEAP_MB: '',
            BUILD_DOWNLOAD_TIMEOUT: '10',
            ...overrides,
          },
          timeout: 15_000,
        },
      )
    const defaults = run()
    assert.equal(defaults.status, 0, defaults.stderr)
    assert.deepEqual(
      (await readFile(output, 'utf8')).trimEnd().split(/\r?\n/u),
      [
        '--max-old-space-size=768',
        '1',
        '1',
        'async',
        '',
        '',
        'yarn',
        'install',
        '--immutable',
      ],
    )
    const mirror = 'https://mirror.example'
    const customized = run({
      BUILD_YARN_NETWORK_CONCURRENCY: '2',
      BUILD_YARN_TASK_POOL_CONCURRENCY: '2',
      BUILD_YARN_TASK_POOL_MODE: 'workers',
      BUILD_YARN_HEAP_MB: '512',
      YARN_NPM_REGISTRY_SERVER: mirror,
    })
    assert.equal(customized.status, 0, customized.stderr)
    const captured = await readFile(output, 'utf8')
    assert.deepEqual(captured.trimEnd().split(/\r?\n/u), [
      '--max-old-space-size=512',
      '2',
      '2',
      'workers',
      mirror,
      mirror,
      'yarn',
      'install',
      '--immutable',
    ])
    for (const invalid of [
      { BUILD_YARN_NETWORK_CONCURRENCY: '0' },
      { BUILD_YARN_TASK_POOL_CONCURRENCY: '33' },
      { BUILD_YARN_TASK_POOL_MODE: 'unbounded' },
      { BUILD_YARN_HEAP_MB: '-1' },
      { BUILD_DOWNLOAD_TIMEOUT: '0' },
    ]) {
      assert.equal(run(invalid).status, 2)
      assert.equal(await readFile(output, 'utf8'), captured)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

/** 使用 Dockerfile 中实际参数及项目固定 Yarn，验证真实环境解析；不联网或安装依赖。 */
test('项目固定 Yarn 接受构建参数环境，并读取安装约束', async () => {
  const shell = posixShell()
  const parameters: Record<string, string> = {}
  for (const kind of ['backend', 'fronted']) {
    const dockerfile = await readFile(
      resolve(repositoryRoot, `apps/web-admin/deployment/Dockerfile.${kind}`),
      'utf8',
    )
    for (const match of dockerfile.matchAll(/^ARG (\S*YARN\S*)=(\S+)$/gmu)) {
      const [, name, value] = match
      assert.ok(name && value)
      parameters[name] = value
    }
  }
  assert.equal(Object.keys(parameters).length, 4)
  const result = spawnSync(
    shell,
    [
      '-c',
      'corepack yarn config get networkConcurrency && corepack yarn config get taskPoolConcurrency && corepack yarn config get taskPoolMode',
    ],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: `${dirname(shell)}${delimiter}${process.env.PATH ?? ''}`,
        COREPACK_ENABLE_NETWORK: '0',
        COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
        ...parameters,
        YARN_NETWORK_CONCURRENCY: '1',
        YARN_TASK_POOL_CONCURRENCY: '1',
        YARN_TASK_POOL_MODE: 'async',
        NODE_OPTIONS: '--max-old-space-size=768',
      },
    },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.stdout.trim().split(/\r?\n/u), ['1', '1', 'async'])
})

/** frozen 导出必须保留完整版本与原始哈希，不能写锁文件或安装依赖。 */
test('自定义 Python 镜像的导出仍完全锁定并保留平台条件', async () => {
  const directory = await fixture()
  try {
    const lock = resolve(backendRoot, 'uv.lock')
    const before = await readFile(lock)
    const result = spawnSync(
      'uv',
      [
        'export',
        '--frozen',
        '--offline',
        '--no-dev',
        '--no-emit-project',
        '--format',
        'requirements.txt',
        '--no-header',
        '--no-annotate',
        '--output-file',
        resolve(directory, 'locked-requirements.txt'),
      ],
      { cwd: backendRoot, encoding: 'utf8', timeout: 15_000 },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(await readFile(lock), before)
    const requirements = await readFile(
      resolve(directory, 'locked-requirements.txt'),
      'utf8',
    )
    const records = requirements
      .replace(/\\\r?\n\s*/gu, ' ')
      .trim()
      .split(/\r?\n/u)
    assert.ok(records.length > 40)
    for (const record of records) {
      assert.match(record, /^[a-zA-Z0-9_.-]+==[^\s]+/u)
      assert.match(record, /--hash=sha256:[a-f0-9]{64}/u)
      assert.doesNotMatch(record, /https?:|--index-url|--extra-index-url/u)
    }
    assert.match(requirements, /sys_platform == 'win32'/u)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = resolve(repositoryRoot, '.superdsh-work/web-admin-validation')
  await mkdir(root, { recursive: true })
  return mkdtemp(resolve(root, 'build-network-'))
}

function posixShell() {
  if (process.platform !== 'win32') return '/bin/sh'
  const git = execFileSync('where.exe', ['git'], { encoding: 'utf8' })
    .trim()
    .split(/\r?\n/u)[0]
  assert.ok(git, 'Windows 验证需要已安装 Git 的 POSIX shell')
  return resolve(dirname(dirname(git)), 'usr/bin/sh.exe')
}
