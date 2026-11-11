import { mkdir, readFile, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, relative, resolve, sep } from 'node:path'
import { appRoot, backendRoot, repositoryRoot } from '../../scripts/paths.ts'
import {
  pythonEnvironment,
  pythonExecutable,
} from '../../scripts/python-environment.ts'
import { run } from '../../scripts/processes.ts'
import { record } from './parity-contracts.ts'

export interface ExecutedParitySuite {
  id: string
  status: 'passed' | 'failed'
  executed: true
  startedAt: string
  finishedAt: string
  scope: string
  command: string[]
  artifacts: string[]
  observations?: unknown
  error?: string
}

/** 当前目录必须是本轮新建目录；拒绝越界或旧文件冒充本轮证据。 */
export async function freshEvidence(
  directory: string,
  name: string,
  started: number,
): Promise<string> {
  const path = resolve(directory, name)
  const child = relative(directory, path)
  if (
    !child ||
    isAbsolute(child) ||
    child === '..' ||
    child.startsWith('..' + sep)
  )
    throw new Error('差分证据路径越界')
  const metadata = await stat(path)
  if (!metadata.isFile() || metadata.mtimeMs < started - 1000)
    throw new Error('差分证据不是本轮新生成文件')
  return path
}

/** JUnit 必须包含实际用例，无测试、跳过或失败都不能获得执行通过状态。 */
export function suiteCounts(xml: string): Record<string, number> {
  const suites = [...xml.matchAll(/<testsuite\s([^>]+)>/gu)]
  if (!suites.length && /<testsuites>[^]*<\/testsuites>/u.test(xml)) {
    // Node内建测试报告使用无计数的根元素，逐testcase计算且拒绝任何跳过/失败节点。
    const tests = [...xml.matchAll(/<testcase\s/gu)].length
    if (!tests || /<(?:failure|error|skipped)\b/u.test(xml))
      throw new Error('Node JUnit包含未执行、跳过或失败用例')
    return { tests, errors: 0, failures: 0, skipped: 0 }
  }
  if (!suites.length) throw new Error('缺少本轮 JUnit testsuite')
  const total = { tests: 0, errors: 0, failures: 0, skipped: 0 }
  for (const suite of suites) {
    const counts = Object.fromEntries(
      [
        ...suite[1]!.matchAll(/\b(tests|errors|failures|skipped)="([^"]+)"/gu),
      ].map((match) => [match[1]!, Number(match[2])]),
    )
    if (
      !Number.isInteger(counts.tests) ||
      counts.tests! <= 0 ||
      counts.errors !== 0 ||
      counts.failures !== 0 ||
      counts.skipped !== 0 ||
      /<(?:failure|error|skipped)\b/u.test(xml)
    )
      throw new Error('JUnit包含未执行、跳过或失败用例')
    total.tests += counts.tests!
  }
  return total
}

/** 两个自动维度串行执行；GUI、真实Host、原生Office和外部账号不由这些结果代替。 */
export async function executeParitySuites(
  directory: string,
): Promise<ExecutedParitySuite[]> {
  const suites: ExecutedParitySuite[] = []
  const execute = async (
    id: string,
    scope: string,
    command: string[],
    environment: NodeJS.ProcessEnv,
    inspect: (
      output: string,
      started: number,
    ) => Promise<{ artifacts: string[]; observations: unknown }>,
  ) => {
    const output = resolve(directory, id)
    const started = Date.now()
    const result: ExecutedParitySuite = {
      id,
      scope,
      command,
      executed: true,
      status: 'failed',
      startedAt: new Date(started).toISOString(),
      finishedAt: '',
      artifacts: [],
    }
    try {
      // 非递归创建防止重复复用同一阶段目录，阻断历史结果继承。
      await mkdir(output)
      await run(command[0]!, command.slice(1), {
        cwd: repositoryRoot,
        env: environment,
      })
      Object.assign(result, await inspect(output, started))
      result.status = 'passed'
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error)
    } finally {
      result.finishedAt = new Date().toISOString()
      suites.push(result)
    }
  }
  const gates = resolve(directory, 'evidence-gates')
  await execute(
    'evidence-gates',
    '契约展开、证据新鲜度与动态字段白名单反例，不启动业务服务',
    [
      process.execPath,
      '--test',
      '--test-reporter=junit',
      `--test-reporter-destination=${resolve(gates, 'results.xml')}`,
      resolve(appRoot, 'tests/tooling/parity.test.ts'),
      resolve(appRoot, 'tests/tooling/parity-execution.test.ts'),
      resolve(appRoot, 'tests/parity/live/normalization.test.ts'),
    ],
    process.env,
    async (output, started) => {
      const junit = await freshEvidence(output, 'results.xml', started)
      return {
        artifacts: [junit],
        observations: suiteCounts(await readFile(junit, 'utf8')),
      }
    },
  )
  const pure = resolve(directory, 'handler-and-office')
  const pureEnvironment = pythonEnvironment({
    ...process.env,
    PYTHONPATH: [backendRoot, resolve(appRoot, 'tests')].join(delimiter),
    PYTHONIOENCODING: 'utf-8',
    WEB_ADMIN_VALIDATION_DIR: pure,
    WEB_ADMIN_PARITY_RUN_ID: directory,
    WEB_ADMIN_PARITY_EVIDENCE_DIR: pure,
    PYTHONPYCACHEPREFIX: resolve(pure, 'pycache'),
  })
  await execute(
    'handler-and-office',
    '旧真实handler/模型规则/菜单/角色与新ASGI；内存端口；旧新Office生成器结构，不含原生Office编辑',
    [
      pythonExecutable(),
      '-m',
      'pytest',
      '-c',
      resolve(backendRoot, 'pyproject.toml'),
      resolve(appRoot, 'tests/contracts/test_identity_navigation_parity.py'),
      resolve(appRoot, 'tests/backend/test_runtime_differential.py'),
      resolve(appRoot, 'tests/backend/test_conversation_query_differential.py'),
      resolve(appRoot, 'tests/backend/test_conversation_batch_differential.py'),
      resolve(appRoot, 'tests/backend/test_session_listing_differential.py'),
      resolve(appRoot, 'tests/backend/test_project_client_parity.py'),
      resolve(appRoot, 'tests/backend/test_session_import_parity.py'),
      resolve(appRoot, 'tests/backend/test_inline_attachment_parity.py'),
      resolve(appRoot, 'tests/backend/test_terminal_parity.py') +
        '::test_terminal_create_matches_actual_legacy_handler',
      resolve(appRoot, 'tests/backend/test_terminal_parity.py') +
        '::test_terminal_defaults_and_invalid_process_parameters',
      resolve(appRoot, 'tests/backend/test_terminal_response_parity.py'),
      resolve(
        appRoot,
        'tests/backend/test_terminal_snapshot_cursor_differential.py',
      ),
      resolve(
        appRoot,
        'tests/backend/test_runtime_create_boundary_differential.py',
      ),
      resolve(appRoot, 'tests/backend/test_identity_input_differential.py'),
      resolve(appRoot, 'tests/backend/test_identity_boundary_differential.py'),
      resolve(appRoot, 'tests/backend/test_pairing_boundary_differential.py'),
      resolve(appRoot, 'tests/backend/test_dashboard_settings_parity.py'),
      resolve(appRoot, 'tests/backend/test_office_differential.py'),
      '-q',
      '--tb=short',
      '--basetemp',
      resolve(pure, 'pytest'),
      `--junitxml=${resolve(pure, 'results.xml')}`,
    ],
    pureEnvironment,
    async (output, started) => {
      const junit = await freshEvidence(output, 'results.xml', started)
      const counts = suiteCounts(await readFile(junit, 'utf8'))
      const contract = await freshEvidence(
        output,
        'identity-navigation-evidence.json',
        started,
      )
      const evidence = record(JSON.parse(await readFile(contract, 'utf8')))
      if (
        evidence.runId !== directory ||
        !Array.isArray(evidence.cases) ||
        !evidence.cases.length ||
        evidence.cases.some((item) => record(item).passed !== true)
      )
        throw new Error('本轮身份管理差分证据不完整或失败')
      return {
        artifacts: [junit, contract],
        observations: {
          pytest: counts,
          explicitIdentityCases: evidence.cases.length,
          ports: 'synthetic-memory-no-database',
        },
      }
    },
  )
  const live = resolve(directory, 'live-http')
  await execute(
    'live-http',
    '两套真实HTTP与7WS认证边界、已选管理/设备/附件场景；独立PostgreSQL/Redis/Home，无外部模型调用',
    [process.execPath, resolve(appRoot, 'tests/parity/live/run.ts')],
    { ...process.env, WEB_ADMIN_PARITY_OUTPUT: live },
    async (output, started) => {
      const path = await freshEvidence(output, 'http-evidence.json', started)
      const evidence = record(JSON.parse(await readFile(path, 'utf8')))
      const baseline = JSON.parse(
        await readFile(
          resolve(appRoot, 'tests/fixtures/baselines/routes.json'),
          'utf8',
        ),
      ) as { transport: string }[]
      const cases = evidence.cases,
        sockets = evidence.sockets,
        scenarios = evidence.scenarios
      if (
        !Array.isArray(cases) ||
        cases.length !==
          baseline.filter((item) => item.transport === 'http').length ||
        !Array.isArray(sockets) ||
        sockets.length !==
          baseline.filter((item) => item.transport === 'websocket').length ||
        !Array.isArray(scenarios) ||
        !scenarios.length ||
        scenarios.some((item) => record(item).passed !== true)
      )
        throw new Error('本轮HTTP/WS或正向场景证据缺失或失败')
      if (
        evidence.cleanup !==
        'owned-databases-containers-processes-and-home-removed'
      )
        throw new Error('本轮双服务测试资源尚未完整回收')
      const summary = record(evidence.summary)
      if (
        summary.normalizedDifferences !== 0 ||
        summary.socketDifferences !== 0 ||
        summary.scenarioFailures !== 0
      )
        throw new Error('本轮真实协议或业务观察存在未解释差异')
      return {
        artifacts: [path],
        observations: {
          summary: evidence.summary,
          sockets: sockets.length,
          scenarios: scenarios.length,
          cleanup: evidence.cleanup,
          fullParity: false,
        },
      }
    },
  )
  return suites
}
