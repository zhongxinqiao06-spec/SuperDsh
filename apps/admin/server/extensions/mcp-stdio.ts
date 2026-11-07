import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  ReadBuffer,
  serializeMessage,
} from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { stopToolProcess, toolEnvironment } from './process.ts'

/** MCP protocol transport with the same owned process-group lifecycle as other tools. */
export class ManagedMcpStdio implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  private child?: ChildProcessWithoutNullStreams
  private closed?: Promise<void>
  private readonly entrypoint: string
  private readonly directory: string
  constructor(entrypoint: string, directory: string) {
    this.entrypoint = entrypoint
    this.directory = directory
  }
  async start() {
    if (this.child) throw new Error('MCP transport already started')
    const child = spawn(process.execPath, [this.entrypoint], {
      cwd: this.directory,
      env: toolEnvironment(this.directory),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      shell: false,
    })
    this.child = child
    this.closed = new Promise((resolve) =>
      child.once('close', () => {
        resolve()
        this.onclose?.()
      }),
    )
    child.stderr.resume()
    child.stdin.on('error', () =>
      this.onerror?.(new Error('MCP stdio write failed')),
    )
    const buffer = new ReadBuffer({ maxBufferSize: 16 * 1024 * 1024 })
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        buffer.append(chunk)
        let message: JSONRPCMessage | null
        while ((message = buffer.readMessage())) this.onmessage?.(message)
      } catch {
        this.onerror?.(new Error('MCP stdio protocol invalid'))
        void this.close()
      }
    })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', () => reject(new Error('MCP stdio launch failed')))
    })
  }
  async send(message: JSONRPCMessage) {
    if (!this.child) throw new Error('MCP transport not started')
    await new Promise<void>((resolve, reject) =>
      this.child!.stdin.write(serializeMessage(message), (error) =>
        error ? reject(new Error('MCP stdio send failed')) : resolve(),
      ),
    )
  }
  async close() {
    const child = this.child
    if (!child) return
    this.child = undefined
    child.stdin.end()
    await stopToolProcess(child)
    await this.closed
  }
}
