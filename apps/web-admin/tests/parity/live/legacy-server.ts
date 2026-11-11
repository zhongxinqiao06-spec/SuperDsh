import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

interface Configuration {
  databaseUrl: string
  redisUrl: string
  secret: string
  encryptionKey: string
  dataDirectory: string
  filesDirectory: string
  hostname: string
  port: number
  apiPort: number
  origins: string[]
  setupToken: string
  qdrantUrl: string
  dev: boolean
}
interface Platform {
  address: { port: number }
  close(): Promise<void>
}

/** 只运行验证目录内的冻结源码；凭据通过父子管道传入，不出现在命令行。 */
async function main() {
  const lines = createInterface({ input: process.stdin })
  const iterator = lines[Symbol.asyncIterator]()
  const first = await iterator.next()
  if (first.done) throw new Error('缺少隔离平台配置')
  const input = JSON.parse(first.value) as {
    source: string
    configuration: Configuration
  }
  const entry = resolve(input.source, 'server/main.ts')
  const module = (await import(pathToFileURL(entry).href)) as {
    startNodePlatform(
      config: Configuration,
      options: { web: boolean; log(message: string): void },
    ): Promise<Platform>
  }
  const platform = await module.startNodePlatform(input.configuration, {
    web: false,
    log: (message) => process.stderr.write(`${message}\n`),
  })
  process.stdout.write(`@@parity-ready@@${platform.address.port}\n`)
  try {
    for (;;) {
      const next = await iterator.next()
      if (next.done) break
      const message = JSON.parse(next.value) as { command?: string }
      if (message.command === 'shutdown') break
    }
  } finally {
    lines.close()
    await platform.close()
  }
}

await main()
