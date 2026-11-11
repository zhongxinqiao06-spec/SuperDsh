import { createRequire } from 'node:module'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { resolve } from 'node:path'
import { repositoryRoot } from '../../../scripts/paths.ts'

interface SocketPort {
  on(event: 'open', listener: () => void): void
  on(
    event: 'unexpected-response',
    listener: (request: ClientRequest, response: IncomingMessage) => void,
  ): void
  on(event: 'message', listener: (raw: Buffer, binary: boolean) => void): void
  on(event: 'close', listener: (code: number) => void): void
  on(event: 'error', listener: () => void): void
  close(code: number): void
  terminate(): void
}

// 对照测试复用已锁定的旧测试依赖，不把旧业务源加入新应用编译图。
const WebSocket = createRequire(
  resolve(repositoryRoot, 'apps/admin/package.json'),
)('ws') as new (
  url: string,
  options: { handshakeTimeout: number },
) => SocketPort

export interface SocketObservation {
  status: number
  frames: unknown[]
  closeCode?: number
  failure?: string
}

/** 真实loopback升级与帧采集，不用浏览器mock替代网络握手。 */
export async function socketObservation(
  base: string,
  path: string,
  options: { frameCount?: number; afterFirstFrame?: () => Promise<void> } = {},
): Promise<SocketObservation> {
  return new Promise((done) => {
    const socket = new WebSocket(base.replace('http:', 'ws:') + path, {
      handshakeTimeout: 5000,
    })
    const result: SocketObservation = { status: 0, frames: [] }
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done(result)
    }
    const timer = setTimeout(() => {
      result.failure = 'no-frame-within-five-seconds'
      socket.terminate()
      finish()
    }, 5000)
    socket.on('open', () => {
      result.status = 101
    })
    socket.on('unexpected-response', (_request, response) => {
      result.status = response.statusCode ?? 0
      response.resume()
      response.on('end', () => {
        socket.terminate()
        finish()
      })
    })
    socket.on('message', (raw, binary) => {
      if (binary) result.frames.push({ binary: true, bytes: raw.byteLength })
      else {
        try {
          result.frames.push(JSON.parse(raw.toString()) as unknown)
        } catch {
          result.failure = 'non-json-frame'
        }
      }
      if (result.frames.length === 1 && options.afterFirstFrame) {
        void options.afterFirstFrame().catch(() => {
          result.failure = 'frame-trigger-failed'
          socket.close(1000)
        })
      }
      if (result.failure || result.frames.length >= (options.frameCount ?? 1))
        socket.close(1000)
    })
    socket.on('close', (code) => {
      result.closeCode = code
      finish()
    })
    socket.on('error', () => {
      if (!result.status) result.failure = 'socket-error'
      finish()
    })
  })
}
