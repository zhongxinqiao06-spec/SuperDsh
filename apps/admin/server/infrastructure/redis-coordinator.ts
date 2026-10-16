import { createHash } from 'node:crypto'
import { createClient } from 'redis'

/** Shared expiration and rate-limit state; durable conversation data remains in PG. */
export class RedisCoordinator {
  private readonly client: ReturnType<typeof createClient>
  private readonly prefix: string
  constructor(url: string, databaseIdentity: string) {
    this.client = createClient({
      url,
      socket: { connectTimeout: 5000, reconnectStrategy: false },
    })
    this.prefix = `superdsh:node:${createHash('sha256').update(databaseIdentity).digest('hex').slice(0, 20)}:`
    this.client.on('error', () => {
      console.error('Redis connection unavailable')
    })
  }
  async start(): Promise<void> {
    await this.client.connect()
    await this.client.ping()
  }
  async ready(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG'
    } catch {
      return false
    }
  }
  async close(): Promise<void> {
    if (this.client.isOpen) await this.client.close()
  }
  async take(key: string, maximum: number, windowMs: number): Promise<boolean> {
    const id = `${this.prefix}limit:${createHash('sha256').update(key).digest('hex')}`
    const result = await this.client.eval(
      'local n=redis.call("INCR",KEYS[1]); if n==1 then redis.call("PEXPIRE",KEYS[1],ARGV[1]); end; return n',
      { keys: [id], arguments: [String(windowMs)] },
    )
    return Number(result) <= maximum
  }
  async put(key: string, value: string, ttlMs: number): Promise<void> {
    await this.client.set(`${this.prefix}${key}`, value, { PX: ttlMs })
  }
  async consume(key: string): Promise<string | null> {
    return this.client.getDel(`${this.prefix}${key}`)
  }
}
