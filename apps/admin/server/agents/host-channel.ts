import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import type { AgentBinding, BusinessAgentPort } from './contracts.ts'
import { ApiError } from '../http/api-router.ts'
import { parseAgentToolContext } from './tool-context.ts'

/** IPC capability is bound to the owning Host process, never a browser token. */
export class BusinessHostChannel {
  private readonly child: ChildProcess
  private readonly owner: string
  private readonly port: BusinessAgentPort
  private readonly pending = new Map<
    string,
    { resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >()
  private readonly running = new Map<string, AbortController>()
  private closed = false
  constructor(child: ChildProcess, owner: string, port: BusinessAgentPort) {
    this.child = child
    this.owner = owner
    this.port = port
    child.on('message', this.receive)
  }
  private readonly receive = (value: unknown) => {
    if (!value || typeof value !== 'object' || this.closed) return
    const message = value as Record<string, unknown>
    const id = typeof message.id === 'string' ? message.id : ''
    if (message.type === 'business-installed') {
      const request = this.pending.get(id)
      if (!request) return
      clearTimeout(request.timer)
      this.pending.delete(id)
      if (message.error) request.reject(new Error('业务智能体运行配置加载失败'))
      else request.resolve()
    }
    if (message.type === 'business-tool-cancel') this.running.get(id)?.abort()
    if (message.type !== 'business-tool' || !id || this.running.has(id)) return
    const controller = new AbortController()
    this.running.set(id, controller)
    void (async () => {
      if (
        typeof message.sessionId !== 'string' ||
        typeof message.tool !== 'string' ||
        !message.args ||
        typeof message.args !== 'object' ||
        Array.isArray(message.args)
      )
        throw new ApiError(422, '无效工具请求')
      const context = parseAgentToolContext(message.context)
      if (context.sessionId !== message.sessionId)
        throw new ApiError(403, '业务工具会话不匹配')
      const result = await this.port.execute(
        this.owner,
        message.sessionId,
        message.tool,
        message.args as Record<string, unknown>,
        controller.signal,
        context,
      )
      if (this.child.connected && !controller.signal.aborted)
        this.child.send({ type: 'business-tool-result', id, result }, () => {})
    })()
      .catch((error: unknown) => {
        if (this.child.connected && !controller.signal.aborted)
          this.child.send(
            {
              type: 'business-tool-result',
              id,
              error:
                error instanceof ApiError
                  ? error.message
                  : '办公工具执行失败，请检查资料格式后重试',
            },
            () => {},
          )
      })
      .finally(() => this.running.delete(id))
  }
  install(binding: AgentBinding): Promise<void> {
    if (this.closed || !this.child.connected)
      return Promise.reject(new Error('Harness 已停止'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('业务智能体准备超时'))
      }, 30000)
      this.pending.set(id, { resolve, reject, timer })
      this.child.send({ type: 'business-install', id, binding }, (error) => {
        if (!error) return
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      })
    })
  }
  async prepare(sessionId: string): Promise<string | undefined> {
    const binding = await this.port.binding(this.owner, sessionId)
    if (!binding) return undefined
    await this.install(binding)
    return binding.presetId
  }
  close() {
    this.closed = true
    this.child.removeListener('message', this.receive)
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('Harness 已停止'))
    }
    this.pending.clear()
    for (const controller of this.running.values()) controller.abort()
    this.running.clear()
  }
}
