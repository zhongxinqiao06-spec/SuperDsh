import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, relative, isAbsolute, delimiter } from 'node:path'
import { appRoot, backendRoot, repositoryRoot } from '../../scripts/paths.ts'
import {
  pythonEnvironment,
  pythonExecutable,
} from '../../scripts/python-environment.ts'
import { run } from '../../scripts/processes.ts'
import { sourceFingerprint } from './baseline.mjs'
import { verifyOwnership } from './ownership.ts'
import { executeParitySuites } from './parity-execution.ts'
import {
  contractProjection,
  indexedEvidence,
  record,
  templateMatches,
} from './parity-contracts.ts'

interface SourceFile {
  path: string
  sha256: string | null
}
interface Route {
  method: string
  transport: string
  path: string
}
interface Mapping {
  method: string
  transport: string
  legacy: string
  canonical: string
  responseEnvelope?: string
}
interface TestReference {
  path: string
  cases: string[]
}
interface Task {
  id: string
  title: string
  moduleIds: string[]
  tests: TestReference[]
}
interface FeatureModule {
  id: string
  taskIds: string[]
}
interface Scenario {
  id: string
  title: string
  route: string
  taskIds: string[]
}
interface Features {
  tasks: Task[]
  modules: FeatureModule[]
  nonMenuScenarios: Scenario[]
  environmentGates: { id: string; reason: string }[]
  evidenceGroups: {
    id: string
    planTaskIds: string[]
    taskIds: string[]
    suiteId?: string
    command: string
    sources: string[]
    artifacts: string[]
    status: string
    scope: string
  }[]
}
interface Inventory {
  routes: Route[]
  openapi: Record<string, unknown>
  architectureIssues: { path: string; detail: string }[]
  lifespanStarted: boolean
}
interface Issue {
  id: string
  status: 'difference' | 'pending' | 'environment'
  detail: string
  references?: string[]
}

const baselineRoot = resolve(appRoot, 'tests/fixtures/baselines')
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
const json = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, 'utf8')) as unknown

/** 清单只能引用仓库内已存在源文件，不接受绝对路径或遍历。 */
function checkedFile(path: string): string {
  const target = resolve(repositoryRoot, path)
  const child = relative(repositoryRoot, target)
  if (isAbsolute(path) || child.startsWith('..') || !existsSync(target))
    throw new Error(`无效索引路径：${path}`)
  return target
}

/** 结构检查与当轮选定差分分别记录；自动范围通过不等于第三阶段全量等价。 */
export async function runParity(reportOnly = false): Promise<number> {
  const directory = resolve(
    repositoryRoot,
    '.superdsh-work/web-admin-validation',
    `parity-${Date.now()}-${randomUUID().slice(0, 8)}`,
  )
  await mkdir(directory, { recursive: true })
  const issues: Issue[] = []
  const structuralErrors: string[] = []
  const baseline = record(
    await json(resolve(baselineRoot, 'source-fingerprint.json')),
  )
  const expected = baseline.files as SourceFile[]
  const actual = (await sourceFingerprint()) as SourceFile[]
  const previous = new Map(expected.map((entry) => [entry.path, entry.sha256]))
  const observed = new Map(actual.map((entry) => [entry.path, entry.sha256]))
  const sourceChanges = [
    ...new Set([...previous.keys(), ...observed.keys()]),
  ].filter((path) => previous.get(path) !== observed.get(path))
  if (sourceChanges.length)
    structuralErrors.push(`旧包来源改变：${sourceChanges.join(', ')}`)
  if (hash(expected) !== baseline.fingerprint)
    structuralErrors.push('冻结源码清单摘要与内容不一致')

  const features = (await json(
    resolve(appRoot, 'tests/parity/features.json'),
  )) as Features
  const plan = await readFile(
    resolve(
      repositoryRoot,
      'docs/plans/web-admin-02-function-and-interaction.md',
    ),
    'utf8',
  )
  const taskIds = [...plan.matchAll(/^### (P2-\d+) /gmu)].map(
    (match) => match[1]!,
  )
  const featureIds = features.tasks.map((task) => task.id)
  if (
    new Set(featureIds).size !== featureIds.length ||
    taskIds.some((id) => !featureIds.includes(id))
  )
    structuralErrors.push('计划二任务索引重复或遗漏')
  const parityPlan = await readFile(
    resolve(repositoryRoot, 'docs/plans/web-admin-03-parity-validation.md'),
    'utf8',
  )
  const parityTaskIds = [...parityPlan.matchAll(/^## (P3-\d+) /gmu)].map(
    (match) => match[1]!,
  )
  const groupIds = features.evidenceGroups.map((group) => group.id)
  if (!groupIds.length || new Set(groupIds).size !== groupIds.length)
    structuralErrors.push('第三阶段证据分组为空或重复')
  for (const group of features.evidenceGroups) {
    if (
      !group.sources.length ||
      !group.planTaskIds.length ||
      group.taskIds.some((id) => !featureIds.includes(id)) ||
      group.planTaskIds.some((id) => !parityTaskIds.includes(id))
    )
      structuralErrors.push(`${group.id} 证据分组缺少来源或引用不存在任务`)
    for (const source of group.sources) {
      try {
        checkedFile(source)
      } catch (error) {
        structuralErrors.push(`${group.id}: ${String(error)}`)
      }
    }
  }
  const frozenModules = (await json(resolve(baselineRoot, 'modules.json'))) as {
    id: string
  }[]
  const moduleIds = features.modules.map((item) => item.id)
  if (
    new Set(moduleIds).size !== moduleIds.length ||
    frozenModules.some((item) => !moduleIds.includes(item.id))
  )
    structuralErrors.push('冻结控制台模块索引重复或遗漏')
  const frontendModules = await readFile(
    resolve(appRoot, 'fronted/src/utils/console/modules.ts'),
    'utf8',
  )
  const registeredModules = [
    ...frontendModules.matchAll(/id: '([^']+)'/gu),
  ].map((match) => match[1]!)
  if (moduleIds.some((id) => !registeredModules.includes(id)))
    structuralErrors.push('功能清单包含未注册前端模块')
  const testIndex = []
  for (const task of features.tasks) {
    if (!task.tests.length) structuralErrors.push(`${task.id} 尚未关联任何用例`)
    for (const reference of task.tests) {
      try {
        if (!reference.path.startsWith('apps/web-admin/tests/'))
          throw new Error('测试引用不属于集中测试目录')
        const source = await readFile(checkedFile(reference.path), 'utf8')
        if (!reference.cases.length) throw new Error('测试引用缺少具体用例')
        const missing = reference.cases.filter((name) => !source.includes(name))
        if (missing.length)
          throw new Error(`测试用例不存在：${missing.join(', ')}`)
        testIndex.push({
          taskId: task.id,
          path: reference.path,
          ...indexedEvidence(reference.cases),
        })
      } catch (error) {
        structuralErrors.push(
          `${task.id}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }
  for (const item of [...features.modules, ...features.nonMenuScenarios]) {
    if (
      !item.taskIds.length ||
      item.taskIds.some((id) => !featureIds.includes(id))
    )
      structuralErrors.push(`${item.id} 关联不存在任务`)
  }
  if (
    new Set(features.nonMenuScenarios.map((item) => item.id)).size !==
      features.nonMenuScenarios.length ||
    !features.nonMenuScenarios.length
  )
    structuralErrors.push('非菜单场景为空或编号重复')

  let inventory: Inventory | undefined
  try {
    const output = resolve(directory, 'new-contracts.json')
    await run(
      pythonExecutable(),
      [resolve(appRoot, 'tests/tooling/parity_inventory.py'), output],
      {
        cwd: backendRoot,
        env: pythonEnvironment({
          PYTHONPATH: [backendRoot, resolve(appRoot, 'tests/tooling')].join(
            delimiter,
          ),
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONIOENCODING: 'utf-8',
          WEB_ADMIN_DATA_DIR: resolve(directory, 'runtime'),
          WEB_ADMIN_VALIDATION_DIR: directory,
        }),
      },
    )
    inventory = (await json(output)) as Inventory
    if (inventory.lifespanStarted || !inventory.routes.length)
      throw new Error('路由采集不满足无副作用约束')
    structuralErrors.push(
      ...inventory.architectureIssues.map(
        (item) => `${item.path}: ${item.detail}`,
      ),
    )
  } catch (error) {
    structuralErrors.push(
      `新契约采集失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  try {
    await verifyOwnership()
  } catch (error) {
    structuralErrors.push(
      error instanceof Error ? error.message : String(error),
    )
  }

  const mappings = record(
    await json(resolve(appRoot, 'deployment/compatibility-routes.json')),
  ).routes as Mapping[]
  const frozenRoutes = (await json(
    resolve(baselineRoot, 'routes.json'),
  )) as Route[]
  const oldOpenapi = record(
    await json(resolve(baselineRoot, 'legacy-openapi.json')),
  )
  const oldPaths = record(oldOpenapi.paths)
  const newPaths = record(inventory?.openapi.paths)
  const routeReport = frozenRoutes.map((route) => {
    const method = route.transport === 'websocket' ? 'WEBSOCKET' : route.method
    const mapping = mappings.find(
      (item) =>
        item.method === method &&
        item.transport === route.transport &&
        templateMatches(item.legacy, route.path),
    )
    const target =
      mapping &&
      inventory?.routes.find(
        (item) =>
          item.method === method &&
          item.transport === route.transport &&
          templateMatches(item.path, mapping.canonical),
      )
    if (!mapping || (inventory && !target))
      structuralErrors.push(`旧入口缺映射或真实目标：${method} ${route.path}`)
    const oldPath = Object.keys(oldPaths).find((path) =>
      templateMatches(path, route.path),
    )
    const newPath =
      target &&
      Object.keys(newPaths).find((path) => templateMatches(path, target.path))
    const oldOperation = oldPath
      ? record(oldPaths[oldPath])[method.toLowerCase()]
      : undefined
    const newOperation = newPath
      ? record(newPaths[newPath])[method.toLowerCase()]
      : undefined
    const left = oldOperation
      ? contractProjection(oldOperation, oldOpenapi)
      : null
    const right = newOperation
      ? contractProjection(newOperation, inventory?.openapi)
      : null
    return {
      ...route,
      canonical: mapping?.canonical ?? null,
      responseEnvelope: mapping?.responseEnvelope ?? null,
      registered: Boolean(target),
      contractStatus:
        method === 'WEBSOCKET'
          ? 'pending-frame-replay'
          : !left || !right
            ? 'pending-missing-schema'
            : hash(left) === hash(right)
              ? 'schema-equal-behavior-unverified'
              : 'schema-difference-review-required',
      oldContract: left,
      newContract: right,
      behaviorStatus: 'not-run',
    }
  })
  const executed =
    !reportOnly && !structuralErrors.length
      ? await executeParitySuites(directory)
      : []
  const livePassed = executed.some(
    (suite) => suite.id === 'live-http' && suite.status === 'passed',
  )
  const automaticPassed =
    executed.length === 3 &&
    executed.every((suite) => suite.status === 'passed')
  if (executed.length) {
    const after = (await sourceFingerprint()) as SourceFile[]
    if (hash(after) !== hash(actual))
      structuralErrors.push('差分执行期间旧包指纹发生变化')
  }
  for (const route of routeReport) {
    if (livePassed)
      route.behaviorStatus =
        route.transport === 'websocket'
          ? 'handshake-boundary-replayed-other-flows-pending'
          : 'authentication-boundary-replayed-other-flows-pending'
  }
  issues.push(
    ...structuralErrors.map((detail, index): Issue => ({
      id: `structure-${index + 1}`,
      status: 'difference',
      detail,
    })),
  )
  issues.push({
    id: 'http-behavior',
    status: 'pending',
    detail: livePassed
      ? '本轮已重放全部冻结HTTP入口的认证边界和选定真实管理/设备/附件场景；未执行的正向、异常组合仍待验证，Schema相等不代表行为相等。'
      : '本轮未获得通过的双HTTP执行证据；结构和OpenAPI相等不代表行为相等。',
  })
  issues.push({
    id: 'ws-frames',
    status: 'pending',
    detail: livePassed
      ? '本轮七个WS握手边界和选定首帧/票据场景已重放；乱序、恢复及真实客户端仍需独立证据。'
      : '七个冻结WS入口已进入目录检查；本轮未获得通过的真实WS执行证据。',
  })
  issues.push({
    id: 'scenario-differential',
    status: 'pending',
    detail:
      '21模块与非菜单场景索引仍完整保留；本命令只证明下面明确列出的当轮自动范围，未纳入的GUI、真实DSH、原生Office和设备验收不能据此关闭。',
    references: ['apps/web-admin/tests/parity/features.json'],
  })
  issues.push(
    ...executed
      .filter((suite) => suite.status !== 'passed')
      .map((suite): Issue => ({
        id: 'suite-' + suite.id,
        status: 'difference',
        detail: suite.error || '本轮执行失败',
        references: suite.artifacts,
      })),
    ...features.environmentGates.map((gate): Issue => ({
      id: gate.id,
      status: 'environment',
      detail: gate.reason,
    })),
  )
  const report = {
    generatedAt: new Date().toISOString(),
    scope: reportOnly
      ? 'phase-three-structural-report-only'
      : 'phase-three-selected-current-run-differential',
    fullParity: false,
    reportOnly,
    automaticScopePassed: automaticPassed,
    status: structuralErrors.length
      ? 'structural-failure'
      : reportOnly
        ? 'structure-passed-behavior-not-run'
        : automaticPassed
          ? 'selected-automation-passed-full-parity-pending'
          : 'selected-automation-failed',
    baseline: {
      expectedFingerprint: baseline.fingerprint,
      observedFingerprint: hash(actual),
      expectedFiles: expected.length,
      observedFiles: actual.length,
      changes: sourceChanges,
    },
    summary: {
      tasks: features.tasks.length,
      modules: features.modules.length,
      nonMenuScenarios: features.nonMenuScenarios.length,
      indexedTestReferences: testIndex.length,
      frozenHttpRoutes: frozenRoutes.filter((item) => item.transport === 'http')
        .length,
      frozenWebsocketRoutes: frozenRoutes.filter(
        (item) => item.transport === 'websocket',
      ).length,
      registeredRoutes: inventory?.routes.length ?? 0,
      compatibilityMappings: mappings.length,
      missingTargets: routeReport.filter((item) => !item.registered).length,
      schemaDifferences: routeReport.filter(
        (item) => item.contractStatus === 'schema-difference-review-required',
      ).length,
      structuralErrors: structuralErrors.length,
    },
    testsExecutedByThisCommand: executed,
    // 只关联本轮明确执行的suite；独立UI/引擎/部署报告不凭源码存在或历史时间戳推断。
    evidenceGroups: features.evidenceGroups.map((group) => {
      const execution = executed.find((suite) => suite.id === group.suiteId)
      return {
        ...group,
        executionStatus: execution?.status ?? 'not-executed-by-this-command',
        currentRunArtifacts: execution?.artifacts ?? [],
        fullGroupParity: false,
      }
    }),
    testIndex,
    routes: routeReport,
    issues,
  }
  await writeFile(
    resolve(directory, 'parity-report.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  const markdown = [
    '# Web Admin 第三阶段差异验证报告',
    '',
    `生成时间：${report.generatedAt}`,
    '',
    '**完整第三阶段差分：仍有待验项。** 结构检查与本轮选定自动套件分别记录；退出码0只表示本次明确选择的范围通过，不代表功能、样式、原生客户端已全量无差异。',
    '',
    `旧包：${actual.length} 文件，指纹 ${report.baseline.observedFingerprint}，变化 ${sourceChanges.length}。`,
    `索引：${features.tasks.length} 任务、${features.modules.length} 模块、${features.nonMenuScenarios.length} 非菜单场景、${testIndex.length} 测试引用。`,
    `入口：${report.summary.frozenHttpRoutes} HTTP + ${report.summary.frozenWebsocketRoutes} WS；缺失 ${report.summary.missingTargets}；Schema待审差异 ${report.summary.schemaDifferences}。`,
    '',
    '## 本轮实际执行',
    '',
    ...(executed.length
      ? executed.map(
          (suite) =>
            `- **${suite.id}** (${suite.status})：${suite.scope}；证据 ${suite.artifacts.map((path) => relative(repositoryRoot, path)).join('，') || '未生成有效证据'}。`,
        )
      : ['本轮仅结构检查或结构前置检查失败，没有将历史报告计为执行通过。']),
    '',
    '## 未关闭项',
    '',
    ...issues.map(
      (issue) =>
        `- **${issue.id}** (${issue.status})：${issue.detail.replaceAll('\n', '；')}`,
    ),
    '',
    '## 复现',
    '',
    '`corepack yarn web-admin:parity` 串行重跑证据门禁、旧新处理器/Office结构差分、隔离双HTTP/WS与选定真实管理场景；任何失败、漏证据或资源回收失败返回非零。',
    '`corepack yarn web-admin:parity --report-only` 只执行结构检查；不会读取历史JSON冒充本轮行为通过。',
    '',
    '完整原始观察、规范化规则、清理结果和具体执行范围见本目录JSON及各套件子目录；外部付费模型、真实设备、原生Office和全量视觉仍保留独立门禁。',
    '',
  ].join('\n')
  await writeFile(resolve(directory, 'parity-report.md'), markdown)
  console.log(
    `差分报告：${resolve(directory, 'parity-report.md')}\n本轮自动范围${automaticPassed ? '通过' : reportOnly ? '未执行' : '未通过'}；完整等价仍待独立验收，结构错误 ${structuralErrors.length}，待审Schema ${report.summary.schemaDifferences}`,
  )
  return structuralErrors.length ? 1 : reportOnly || automaticPassed ? 0 : 1
}
