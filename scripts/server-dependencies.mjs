import { spawnSync } from 'node:child_process'
import { createServer } from 'node:net'

const dependencies = [
  {
    service: 'postgres',
    setting: 'SUPERDSH_DEV_PG_PORT',
    internalPort: '5432/tcp',
  },
  {
    service: 'redis',
    setting: 'SUPERDSH_DEV_REDIS_PORT',
    internalPort: '6379/tcp',
  },
  {
    service: 'qdrant',
    setting: 'SUPERDSH_DEV_QDRANT_PORT',
    internalPort: '6333/tcp',
  },
]

export function inspectDevelopmentContainers() {
  const run = (args) => {
    const result = spawnSync('docker', args, {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    })
    if (result.error || result.status !== 0)
      throw new Error(
        'Cannot inspect development containers; no dependencies were changed.',
      )
    return result.stdout
  }
  const ids = run([
    'ps',
    '-aq',
    '--filter',
    'label=com.docker.compose.project=superdsh-dev',
  ])
    .split(/\s+/)
    .filter(Boolean)
  return ids.length ? JSON.parse(run(['inspect', ...ids])) : []
}

export function isLoopbackPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', (error) => {
      if (['EADDRINUSE', 'EACCES'].includes(error.code)) resolve(false)
      else reject(error)
    })
    server.listen(
      { host: '127.0.0.1', port: Number(port), exclusive: true },
      () => {
        server.close((error) => (error ? reject(error) : resolve(true)))
      },
    )
  })
}

export async function planDevelopmentDependencies(
  containers,
  environment,
  { portAvailable = isLoopbackPortAvailable, explicitEnvironment = {} } = {},
) {
  const plan = { ports: {}, ready: [], start: [], wait: [] }
  const reserved = new Set()
  const owned = new Map()
  for (const dependency of dependencies) {
    const { service, setting, internalPort } = dependency
    const matches = containers.filter((container) => {
      const labels = container.Config?.Labels
      return (
        labels?.['com.docker.compose.project'] === 'superdsh-dev' &&
        labels?.['com.docker.compose.service'] === service &&
        String(labels?.['com.docker.compose.oneoff']).toLowerCase() !== 'true'
      )
    })
    if (matches.length > 1)
      throw new Error(
        `Multiple superdsh-dev ${service} containers found; resolve the duplicate before retrying.`,
      )
    const container = matches[0]
    owned.set(service, container)
    if (container?.State?.Paused || container?.State?.Restarting)
      throw new Error(
        `superdsh-dev ${service} is paused or restarting; inspect its logs before retrying.`,
      )
    if (!container?.State?.Running) continue
    const bindings = container.NetworkSettings?.Ports?.[internalPort] ?? []
    if (bindings.length !== 1 || bindings[0].HostIp !== '127.0.0.1')
      throw new Error(
        `superdsh-dev ${service} must publish exactly one loopback port; no container was recreated.`,
      )
    const actual = checkedPort(bindings[0].HostPort, setting)
    if (
      explicitEnvironment[setting] &&
      checkedPort(explicitEnvironment[setting], setting) !== actual
    )
      throw new Error(
        `${setting} differs from the running ${service} port ${actual}; clear or correct the shell override.`,
      )
    if (container.State.Health?.Status === 'unhealthy')
      throw new Error(
        `superdsh-dev ${service} is unhealthy; inspect its logs before retrying.`,
      )
    if (reserved.has(actual))
      throw new Error(
        `Development dependencies share port ${actual}; check Docker mappings.`,
      )
    reserved.add(actual)
    plan.ports[setting] = actual
    plan[container.State.Health?.Status === 'healthy' ? 'ready' : 'wait'].push(
      service,
    )
  }
  for (const { service, setting } of dependencies) {
    if (owned.get(service)?.State?.Running) continue
    const requested = checkedPort(environment[setting], setting)
    let selected
    for (
      let candidate = +requested;
      candidate <= Math.min(+requested + 100, 65535);
      candidate++
    ) {
      const value = String(candidate)
      if (!reserved.has(value) && (await portAvailable(value))) {
        selected = value
        break
      }
      if (explicitEnvironment[setting])
        throw new Error(
          `${setting}=${requested} is occupied. Clear the shell override for automatic port selection, or choose a free port.`,
        )
    }
    if (!selected)
      throw new Error(
        `No free loopback port near ${requested}; configure ${setting} and retry.`,
      )
    reserved.add(selected)
    plan.ports[setting] = selected
    plan.start.push(service)
  }
  return plan
}

function checkedPort(value, setting) {
  if (!/^\d+$/.test(String(value)) || +value < 1 || +value > 65535)
    throw new Error(`${setting} must be a port from 1 to 65535`)
  return String(+value)
}
