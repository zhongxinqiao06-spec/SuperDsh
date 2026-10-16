import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { object } from '../http/api-router.ts'
import type {
  HarnessBridgeClient,
  RuntimeNotification,
} from './bridge-client.ts'

export function checkpoint(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (
    item.version !== 1 ||
    item.projectionVersion !== 2 ||
    !Number.isSafeInteger(item.throughSeq) ||
    Number(item.throughSeq) < -1 ||
    typeof item.settled !== 'boolean' ||
    typeof item.historyHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(item.historyHash)
  )
    return null
  return {
    version: 1,
    projectionVersion: 2,
    throughSeq: item.throughSeq,
    historyHash: item.historyHash,
    settled: item.settled,
  }
}
/** ACKs follow durable ingestion; transport receipt never advances persisted checkpoints. */
export class BridgeSync {
  private readonly client: HarnessBridgeClient
  private readonly directory: string
  private readonly ingest: (events: RuntimeNotification[]) => Promise<void>
  private readonly healthy: () => Promise<void>
  private readonly failed: () => void
  private streamId: string | null = null
  private expected = 1
  private queue: Promise<void> = Promise.resolve()
  private stopped = false
  private subscribing = false
  private backlog: Record<string, unknown>[] = []
  private durable = false
  private snapshot: {
    begin: Record<string, unknown>
    items: Record<string, unknown>[]
    ids: Set<string>
    bytes: number
  } | null = null
  constructor(options: {
    client: HarnessBridgeClient
    directory: string
    ingest(events: RuntimeNotification[]): Promise<void>
    healthy(): Promise<void>
    failed(): void
  }) {
    this.client = options.client
    this.directory = options.directory
    this.ingest = options.ingest
    this.healthy = options.healthy
    this.failed = options.failed
  }
  async start(): Promise<void> {
    this.subscribing = true
    this.snapshot = null
    try {
      const result = object(
        await this.client.request('runtime.sync.subscribe', {
          checkpointVersion: 1,
        }),
      )
      if (result.projectionVersion !== 2 || typeof result.streamId !== 'string')
        throw new Error('Unsupported DSH projection')
      this.streamId = result.streamId
      this.expected = 1
      this.durable = result.checkpointVersion === 1
    } finally {
      this.subscribing = false
    }
    for (const batch of this.backlog.splice(0)) this.accept(batch)
  }
  accept(batch: Record<string, unknown>): void {
    if (this.stopped) return
    if (this.subscribing) {
      if (this.backlog.length >= 4) {
        this.failed()
        return
      }
      this.backlog.push(batch)
      return
    }
    this.queue = this.queue
      .then(() => this.consume(batch))
      .catch(async () => {
        if (this.stopped) return
        this.snapshot = null
        try {
          await this.start()
        } catch {
          this.failed()
        }
      })
  }
  stop(): Promise<void> {
    this.stopped = true
    this.snapshot = null
    return this.queue.catch(() => {})
  }
  private file(externalId: string): string {
    return join(
      this.directory,
      `${createHash('sha256').update(externalId).digest('hex')}.json`,
    )
  }
  private async consume(batch: Record<string, unknown>): Promise<void> {
    if (this.stopped || batch.streamId !== this.streamId) return
    if (
      batch.batchSeq !== this.expected ||
      batch.projectionVersion !== 2 ||
      !Array.isArray(batch.operations) ||
      !batch.operations.length
    )
      throw new Error('Out-of-order projection batch')
    const ack: Record<string, unknown> = {
      streamId: this.streamId,
      batchSeq: this.expected,
    }
    for (const raw of batch.operations) {
      const op = object(raw)
      const kind = op.kind
      if (typeof kind === 'string' && kind.startsWith('checkpoint.')) {
        if (
          !this.durable ||
          this.snapshot ||
          typeof op.externalSessionId !== 'string' ||
          !op.externalSessionId
        )
          throw new Error('Checkpoint outside committed boundary')
        const file = this.file(op.externalSessionId)
        if (kind === 'checkpoint.load') {
          try {
            ack.checkpoint = checkpoint(
              JSON.parse(await readFile(file, 'utf8')),
            )
          } catch (error) {
            if (
              (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
              !(error instanceof SyntaxError)
            )
              throw error
            ack.checkpoint = null
          }
        } else if (kind === 'checkpoint.save') {
          const value = checkpoint(op.checkpoint)
          if (!value) throw new Error('Invalid projection checkpoint')
          await mkdir(this.directory, { recursive: true, mode: 0o700 })
          await writeFile(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 })
          await rename(`${file}.tmp`, file)
        } else if (kind === 'checkpoint.delete')
          await unlink(file).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
          })
        else throw new Error('Unknown checkpoint operation')
      } else if (kind === 'snapshot.begin') {
        this.snapshot = { begin: op, items: [], ids: new Set(), bytes: 0 }
      } else if (
        kind === 'snapshot.items' ||
        kind === 'snapshot.commit' ||
        kind === 'snapshot.abort'
      ) {
        const snapshot = this.snapshot
        if (
          !snapshot ||
          op.snapshotId !== snapshot.begin.snapshotId ||
          op.sessionId !== snapshot.begin.sessionId
        )
          throw new Error('Invalid snapshot identity')
        if (kind === 'snapshot.items') {
          if (!Array.isArray(op.items)) throw new Error('Invalid snapshot page')
          for (const rawItem of op.items) {
            const item = object(rawItem)
            if (
              typeof item.id !== 'string' ||
              item.sessionId !== op.sessionId ||
              snapshot.ids.has(item.id)
            )
              throw new Error('Foreign or duplicate timeline item')
            snapshot.ids.add(item.id)
            snapshot.items.push(item)
            snapshot.bytes += Buffer.byteLength(JSON.stringify(item))
            if (snapshot.bytes > 256 * 1024 * 1024)
              throw new Error('Snapshot memory limit reached')
          }
        } else if (kind === 'snapshot.abort') this.snapshot = null
        else {
          if (
            snapshot.ids.size !== op.totalItems ||
            op.throughSeq !== snapshot.begin.throughSeq
          )
            throw new Error('Incomplete snapshot')
          const meta = object(snapshot.begin.meta)
          await this.ingest([
            {
              method: 'session.meta.upsert',
              params: { sessionId: op.sessionId, ...meta },
            },
            {
              method: 'timeline.sync',
              params: {
                sessionId: op.sessionId,
                externalSessionId: meta.externalSessionId,
                items: snapshot.items,
                complete: true,
              },
            },
          ])
          this.snapshot = null
        }
      } else if (kind === 'notifications') {
        if (!Array.isArray(op.notifications))
          throw new Error('Invalid notifications')
        const events = op.notifications.map((raw): RuntimeNotification => {
          const event = object(raw)
          if (typeof event.method !== 'string')
            throw new Error('Invalid notification method')
          return { method: event.method, params: object(event.params) }
        })
        for (const event of events)
          if (
            event.method === 'timeline.itemUpsert' &&
            object(event.params.item).sessionId !== event.params.sessionId
          )
            throw new Error('Foreign timeline item')
        await this.ingest(events)
        if (
          events.some(
            (event) =>
              event.method === 'session.inventory.complete' &&
              event.params.complete === true,
          )
        )
          await this.healthy()
      } else if (kind !== 'workspace.inventory')
        throw new Error('Unknown projection operation')
    }
    await this.client.request('runtime.sync.ack', ack)
    this.expected++
  }
}
