import { connect } from 'node:net'
import type { Socket } from 'node:net'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ApiError, object } from '../http/api-router.ts'

type Pending = { resolve(value: unknown): void; reject(error: unknown): void }
export interface RuntimeNotification {
  method: string
  params: Record<string, unknown>
}
export class HarnessBridgeClient {
  private socket?: Socket
  private readonly pending = new Map<string, Pending>()
  private serial = 0
  private input = Buffer.alloc(0)
  private closed = false
  private early: RuntimeNotification[] = []
  private initialized = false
  readonly notification: (value: RuntimeNotification) => void
  readonly disconnected: () => void
  constructor(options: {
    notification(value: RuntimeNotification): void
    disconnected(): void
  }) {
    this.notification = options.notification
    this.disconnected = options.disconnected
  }
  async start(
    home: string,
    connectorId: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const endpoint = object(
      JSON.parse(
        await readFile(
          join(home, 'agents-anywhere', 'bridge', 'endpoint.json'),
          'utf8',
        ),
      ),
    )
    if (
      endpoint.version !== 1 ||
      endpoint.host !== '127.0.0.1' ||
      typeof endpoint.port !== 'number' ||
      !Number.isInteger(endpoint.port) ||
      endpoint.port < 1 ||
      endpoint.port > 65535 ||
      typeof endpoint.token !== 'string' ||
      !endpoint.token
    )
      throw new Error('Invalid owned Harness endpoint')
    await new Promise<void>((resolve, reject) => {
      signal.throwIfAborted()
      const socket = connect({
        host: '127.0.0.1',
        port: endpoint.port as number,
      })
      this.socket = socket
      const abort = () => {
        socket.destroy()
        reject(new Error('Bridge startup cancelled'))
      }
      signal.addEventListener('abort', abort, { once: true })
      socket.once('connect', () => {
        signal.removeEventListener('abort', abort)
        resolve()
      })
      socket.on('error', () =>
        reject(new Error('Harness Bridge connection failed')),
      )
      socket.on('data', (chunk) => this.receive(chunk))
      socket.once('close', () => {
        signal.removeEventListener('abort', abort)
        this.fail()
        if (!this.closed) this.disconnected()
      })
    })
    try {
      const result = object(
        await this.request(
          'initialize',
          {
            authToken: endpoint.token,
            protocolVersion: '1.0',
            runtime: 'dsh',
            connectorId,
            sessionNamespace: connectorId,
            clientInfo: { name: 'superdsh-node-connector', version: '1.0' },
          },
          signal,
        ),
      )
      const identity = object(result.identity)
      if (
        identity.runtime !== 'dsh' ||
        !String(identity.protocolVersion).startsWith('1.')
      )
        throw new Error('Harness Bridge incompatible protocol')
      this.initialized = true
      for (const event of this.early.splice(0)) this.notification(event)
      return result
    } catch (error) {
      this.close()
      throw error
    }
  }
  get connected(): boolean {
    return Boolean(
      this.socket && !this.socket.destroyed && this.initialized && !this.closed,
    )
  }
  async request(
    method: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.socket || this.socket.destroyed || this.closed)
      throw new ApiError(503, 'Harness Bridge is unavailable')
    signal?.throwIfAborted()
    const id = `node-${++this.serial}`
    let abort = () => {}
    let timer: NodeJS.Timeout | undefined
    try {
      return await new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject })
        abort = () => {
          this.notify('$/cancelRequest', { id })
          reject(new Error('Harness operation cancelled'))
        }
        signal?.addEventListener('abort', abort, { once: true })
        timer = setTimeout(abort, 60_000)
        this.write({ jsonrpc: '2.0', id, method, params })
      })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      this.pending.delete(id)
    }
  }
  notify(method: string, params: Record<string, unknown>): void {
    if (this.socket && !this.socket.destroyed)
      this.write({ jsonrpc: '2.0', method, params })
  }
  close(): void {
    this.closed = true
    this.socket?.destroy()
    this.fail()
  }
  private fail(): void {
    for (const task of this.pending.values())
      task.reject(new ApiError(503, 'Harness Bridge disconnected'))
    this.pending.clear()
  }
  private write(value: unknown): void {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`)
    if (bytes.length > 8 * 1024 * 1024)
      throw new ApiError(413, 'Harness frame exceeds 8 MiB')
    this.socket!.write(bytes)
  }
  private receive(chunk: Buffer): void {
    try {
      this.input = Buffer.concat([this.input, chunk])
      let newline: number
      while ((newline = this.input.indexOf(10)) >= 0) {
        if (newline > 8 * 1024 * 1024) throw new Error('Bridge frame too large')
        const frame = object(
          JSON.parse(this.input.subarray(0, newline).toString('utf8')),
        )
        this.input = this.input.subarray(newline + 1)
        if (frame.jsonrpc !== '2.0') throw new Error('Invalid bridge frame')
        if (typeof frame.id === 'string' && !frame.method) {
          const task = this.pending.get(frame.id)
          if (!task) continue
          if (frame.error) {
            const error = object(frame.error)
            const data =
              error.data && typeof error.data === 'object'
                ? object(error.data)
                : {}
            const failure = new ApiError(
              data.code === 'METHOD_NOT_FOUND'
                ? 501
                : data.code === 'INVALID_REQUEST'
                  ? 422
                  : 409,
              typeof error.message === 'string'
                ? error.message
                : 'Harness operation failed',
            )
            task.reject(failure)
          } else task.resolve(frame.result)
        } else if (typeof frame.method === 'string') {
          if (frame.id) {
            this.write({
              jsonrpc: '2.0',
              id: frame.id,
              error: {
                code: -32601,
                message: 'Connector does not accept bridge requests',
              },
            })
            continue
          }
          const notification = {
            method: frame.method,
            params: object(frame.params ?? {}),
          }
          if (!this.initialized) {
            if (this.early.length >= 64)
              throw new Error('Too many early bridge notifications')
            this.early.push(notification)
          } else this.notification(notification)
        } else throw new Error('Invalid bridge message')
      }
      if (this.input.length > 8 * 1024 * 1024)
        throw new Error('Bridge frame too large')
    } catch {
      this.socket?.destroy()
    }
  }
}
