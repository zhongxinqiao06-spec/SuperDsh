import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { createServer as realCreateServer, type ListenOptions } from 'node:net'
import { mkdtempSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { mkdir, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'

// The pinned bundle keeps this helper private. Exercise its installed implementation,
// including the Yarn patch, with only the network boundary injected.
type Acquire = (
  path: string,
  compromised?: () => void,
) => Promise<() => Promise<void>>
const require = createRequire(import.meta.url)
const source = readFileSync(
  require.resolve('@agents-anywhere/dsh-bridge-next'),
  'utf8',
)
const section = source
  .slice(source.indexOf('async function acquireManagerLock('))
  .split('//#endregion')[0]!
function acquireFor(
  platform: NodeJS.Platform,
  createServer: unknown = realCreateServer,
): Acquire {
  return new Function(
    'bindings',
    `const { mkdir, realpath, dirname, createHash, createServer, process } = bindings;
    const hasCode = (error, code) => error instanceof Error && error.code === code;
    ${section}; return acquireManagerLock;`,
  )({
    mkdir,
    realpath,
    dirname,
    createHash,
    createServer,
    process: { platform },
  }) as Acquire
}
const roots: string[] = []
const root = () => {
  const dir = mkdtempSync(join(tmpdir(), 'superdsh-aa-lock-'))
  roots.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true })
})
function network(codes: (string | null)[]) {
  const ports: number[] = []
  let index = 0
  const createServer = () =>
    Object.assign(new EventEmitter(), {
      listen(this: EventEmitter, options: ListenOptions, done: () => void) {
        ports.push(options.port!)
        const code = codes[Math.min(index++, codes.length - 1)]
        queueMicrotask(() =>
          code
            ? this.emit('error', Object.assign(new Error(code), { code }))
            : done(),
        )
      },
      unref() {},
      close(this: EventEmitter, done: (error?: Error) => void) {
        this.emit('close')
        done()
      },
    })
  return { ports, createServer }
}
it('retries only Windows EACCES using the same bounded identity sequence', async () => {
  const file = join(root(), 'manager.lock')
  const one = network(['EACCES', null])
  const two = network(['EACCES', null])
  await (
    await acquireFor('win32', one.createServer)(file)
  )()
  await (
    await acquireFor('win32', two.createServer)(file)
  )()
  expect(one.ports).toEqual(two.ports)
  expect(one.ports).toHaveLength(2)
  expect((one.ports[1]! - one.ports[0]! + 16384) % 16384).toBe(257)
})
it('does not bypass a competing owner or an unrelated network error', async () => {
  for (const code of ['EADDRINUSE', 'EPERM']) {
    const net = network([code, null])
    await expect(
      acquireFor('win32', net.createServer)(join(root(), 'manager.lock')),
    ).rejects.toThrow(code === 'EADDRINUSE' ? '另一个插件实例' : code)
    expect(net.ports).toHaveLength(1)
  }
})
it('exhausts at 32 Windows candidates and preserves single-attempt Unix behavior', async () => {
  const win = network(['EACCES'])
  await expect(
    acquireFor('win32', win.createServer)(join(root(), 'manager.lock')),
  ).rejects.toThrow('EACCES')
  expect(win.ports).toHaveLength(32)
  expect(new Set(win.ports).size).toBe(32)
  const unix = network(['EACCES', null])
  await expect(
    acquireFor('linux', unix.createServer)(join(root(), 'manager.lock')),
  ).rejects.toThrow('EACCES')
  expect(unix.ports).toHaveLength(1)
})
it('serializes two real holders of the same identity and permits reuse after release', async () => {
  const file = join(root(), 'manager.lock')
  const acquire = acquireFor(process.platform)
  const release = await acquire(file)
  try {
    await expect(acquire(file)).rejects.toThrow('另一个插件实例')
  } finally {
    await release()
  }
  await (
    await acquire(file)
  )()
})
it.skipIf(process.platform !== 'win32')(
  'recovers from an actual Windows excluded TCP port while retaining mutual exclusion',
  async (context) => {
    const text = execFileSync(
      'netsh',
      ['interface', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp'],
      { encoding: 'utf8', windowsHide: true },
    )
    const ranges = [...text.matchAll(/^\s+(\d+)\s+(\d+)\s*\*?\s*$/gm)]
      .map((m) => [Number(m[1]), Number(m[2])] as const)
      .filter(([start, end]) => end >= 49152 && start <= 65535)
    // Machines without exclusions have no EACCES boundary to exercise.
    if (!ranges.length)
      return context.skip(
        'This Windows host has no excluded ephemeral TCP range',
      )
    const parent = root()
    let directory = ''
    const probed = new Set<number>()
    for (let i = 0; i < 100_000 && probed.size < 64; i++) {
      const candidate = join(parent, String(i))
      const value =
        49152 +
        (createHash('sha256')
          .update(candidate.toLowerCase())
          .digest()
          .readUInt16BE(0) %
          16384)
      if (
        probed.has(value) ||
        !ranges.some(([start, end]) => value >= start && value <= end)
      )
        continue
      probed.add(value)
      // A reservation listed by netsh can still admit this account. Exercise an
      // actual EACCES boundary, not the presentation of a changing Windows table.
      const denied = await new Promise<string | undefined>(
        (resolve, reject) => {
          const server = realCreateServer()
          server.once('error', (error) => {
            const code = (error as NodeJS.ErrnoException).code
            if (code === 'EACCES' || code === 'EADDRINUSE') resolve(code)
            else reject(error)
          })
          server.listen(
            { host: '127.0.0.1', port: value, exclusive: true },
            () =>
              server.close((error) =>
                error ? reject(error) : resolve(undefined),
              ),
          )
        },
      )
      if (denied === 'EACCES') {
        directory = candidate
        break
      }
    }
    if (!directory)
      return context.skip(
        'No sampled Windows reservation denied this account; injected EACCES tests remain mandatory',
      )
    mkdirSync(directory)
    const acquire = acquireFor('win32'),
      file = join(directory, 'manager.lock')
    const release = await acquire(file)
    try {
      await expect(acquire(file)).rejects.toThrow('另一个插件实例')
    } finally {
      await release()
    }
    await (
      await acquire(file)
    )()
  },
)
