import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { appRoot, repositoryRoot } from '../../../scripts/paths.ts'
import { verifyBaseline } from '../../tooling/baseline.mjs'
import { templateMatches } from '../../tooling/parity-contracts.ts'
import { twinEnvironment } from './environment.ts'
import { observe, redacted, stable, type Comparison } from './observations.ts'
import { socketObservation, type SocketObservation } from './websocket.ts'
import { businessScenarios, type ScenarioResult } from './scenarios.ts'
import { compareBoundary, normalizationSources } from './normalization.ts'

interface Route {
  method: string
  path: string
  transport: string
}
interface Mapping {
  method: string
  legacy: string
  canonical: string
  transport: string
}

/** 全入口认证边界重放只是独立维度，不能替代正向业务、WS和真实客户端验收。 */
export async function runHttpParity() {
  const started = Date.now()
  const validationRoot = resolve(
    repositoryRoot,
    '.superdsh-work/web-admin-validation',
  )
  const directory = resolve(
    process.env.WEB_ADMIN_PARITY_OUTPUT ||
      resolve(
        validationRoot,
        `http-parity-${Date.now()}-${randomUUID().slice(0, 8)}`,
      ),
  )
  const child = relative(validationRoot, directory)
  if (
    !child ||
    child === '..' ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child)
  )
    throw new Error('HTTP差分输出必须位于独立验证目录内')
  await mkdir(directory, { recursive: true })
  const sources = await normalizationSources()
  const routes = JSON.parse(
    await readFile(
      resolve(appRoot, 'tests/fixtures/baselines/routes.json'),
      'utf8',
    ),
  ) as Route[]
  const mappings = (
    JSON.parse(
      await readFile(
        resolve(appRoot, 'deployment/compatibility-routes.json'),
        'utf8',
      ),
    ) as { routes: Mapping[] }
  ).routes
  const context = await twinEnvironment()
  const cases: Comparison[] = []
  const sockets: {
    path: string
    old: SocketObservation
    compatibility: SocketObservation
    canonical: SocketObservation
  }[] = []
  let scenarios: ScenarioResult[] = []
  try {
    console.log(
      '两套真实 HTTP 服务已启动：独立数据库账号、Redis分库、Home，无外部模型调用',
    )
    for (const route of routes.filter((item) => item.transport === 'http')) {
      const mapping = mappings.find(
        (item) =>
          item.method === route.method &&
          item.transport === 'http' &&
          templateMatches(item.legacy, route.path),
      )
      if (!mapping) throw new Error(`缺入口映射 ${route.path}`)
      const fill = (path: string) =>
        path.replace(/\{[^}]+\}/gu, 'parity-missing-resource')
      const oldPath = fill(route.path)
      const canonicalPath = fill(mapping.canonical)
      const body = ['GET', 'HEAD', 'DELETE'].includes(route.method)
        ? undefined
        : {}
      const old = await observe(context.legacyBase, oldPath, route.method, body)
      const compatibility = await observe(
        context.canonicalBase,
        oldPath,
        route.method,
        body,
      )
      const canonical = await observe(
        context.canonicalBase,
        canonicalPath,
        route.method,
        body,
      )
      const item: Comparison = {
        id: `unauthenticated:${route.method}:${route.path}`,
        method: route.method,
        legacyPath: route.path,
        canonicalPath: mapping.canonical,
        old,
        compatibility,
        canonical,
        equal: stable(old) === stable(compatibility),
        ingressEqual: stable(compatibility) === stable(canonical),
      }
      cases.push(item)
      if (cases.length % 40 === 0)
        console.log(
          `认证边界重放 ${cases.length}/${routes.filter((item) => item.transport === 'http').length}`,
        )
    }
    for (const route of routes.filter(
      (item) => item.transport === 'websocket',
    )) {
      const mapping = mappings.find(
        (item) =>
          item.transport === 'websocket' &&
          templateMatches(item.legacy, route.path),
      )!
      const path = route.path.replace(/\{[^}]+\}/gu, 'parity-missing-resource')
      sockets.push({
        path: route.path,
        old: await socketObservation(context.legacyBase, path),
        compatibility: await socketObservation(context.canonicalBase, path),
        canonical: await socketObservation(
          context.canonicalBase,
          mapping.canonical.replace(/\{[^}]+\}/gu, 'parity-missing-resource'),
        ),
      })
    }
    scenarios = await businessScenarios(context)
  } finally {
    const normalized = cases.map((item) => ({
      id: item.id,
      ...compareBoundary(item.legacyPath, item, sources, {
        started,
        finished: Date.now(),
        oldOrigin: context.legacyBase,
        newOrigin: context.canonicalBase,
      }),
    }))
    const socketDifferences = sockets.filter(
      (item) =>
        stable(item.old) !== stable(item.compatibility) ||
        stable(item.compatibility) !== stable(item.canonical),
    )
    const failedScenarios = scenarios.filter((item) => !item.passed)
    const failures = normalized.filter(
      (item) => !item.equivalent || !item.ingressEquivalent,
    )
    if (
      failures.length ||
      socketDifferences.length ||
      failedScenarios.length ||
      cases.length !==
        routes.filter((item) => item.transport === 'http').length ||
      sockets.length !==
        routes.filter((item) => item.transport === 'websocket').length ||
      !scenarios.length
    )
      process.exitCode = 1
    const report = {
      generatedAt: new Date().toISOString(),
      scope:
        'live-http-auth-boundaries-and-selected-business-websocket-scenarios',
      fullParity: false,
      cases,
      sockets,
      scenarios,
      normalized,
      authoritativeMetadata: sources,
      summary: {
        executed: cases.length,
        exactEqual: cases.filter((item) => item.equal).length,
        ingressEqual: cases.filter((item) => item.ingressEqual).length,
        differences: cases.filter((item) => !item.equal).length,
        normalizedDifferences: failures.length,
        socketDifferences: socketDifferences.length,
        scenarios: scenarios.length,
        scenarioFailures: failedScenarios.length,
      },
      cleanup: 'pending',
    }
    await writeFile(
      resolve(directory, 'http-evidence.json'),
      JSON.stringify(redacted(report), null, 2) + '\n',
    )
    await context.cleanup()
    report.cleanup = 'owned-databases-containers-processes-and-home-removed'
    await writeFile(
      resolve(directory, 'http-evidence.json'),
      JSON.stringify(redacted(report), null, 2) + '\n',
    )
    await verifyBaseline()
    console.log(
      `HTTP 差分证据：${directory}；${JSON.stringify(report.summary)}`,
    )
  }
  return { directory, cases }
}

await runHttpParity()
