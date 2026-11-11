/** 注册 Python 提供的冻结工具描述，业务执行和授权全部通过回调返回 Python。 */
import { randomUUID } from 'node:crypto'
import { fields } from './contracts.ts'
import type {
  Execution,
  Fields,
  Host,
  ToolDefinition,
  ToolDescriptor,
} from './contracts.ts'

type Pending = { settle(message: Fields): void }
type Loader = (name: string) => Promise<unknown>

/** 引擎工具注册与取消桥接；不解释业务阶段，不执行业务代码。 */
export function installTools(
  application: Promise<Host>,
  load: Loader,
  send: (frame: Fields) => void,
) {
  const pending = new Map<string, Pending>()
  const installed = new Map<string, { revision: number; dispose(): void }>()
  const invoke = (
    tool: ToolDescriptor,
    execution: Execution,
    args: Fields,
    context: Fields = {},
  ) =>
    new Promise<Fields>((resolve, reject) => {
      const id = randomUUID()
      // 先建立计时器，再检查已取消状态，避免取消闭包读取未初始化的变量。
      const timeoutSeconds = Math.max(
        30,
        Math.min(tool.timeoutSeconds ?? 300, 600),
      )
      const timer = setTimeout(() => abort(), (timeoutSeconds + 15) * 1000)
      const abort = () => {
        clearTimeout(timer)
        pending.delete(id)
        execution.signal.removeEventListener('abort', abort)
        send({ type: 'tool-cancel', id })
        reject(new Error('工具调用已取消'))
      }
      if (execution.signal.aborted) return abort()
      execution.signal.addEventListener('abort', abort, { once: true })
      pending.set(id, {
        settle(message) {
          clearTimeout(timer)
          execution.signal.removeEventListener('abort', abort)
          if (message.error) reject(new Error('工具执行失败'))
          else resolve(fields(message.result))
        },
      })
      send({
        type: 'tool-call',
        id,
        toolId: tool.id,
        revision: tool.revision,
        externalSessionId: String(execution.agent!.id),
        callId: String(execution.callId),
        arguments: args,
        context,
        timeoutSeconds,
      })
    })
  return {
    /** 只处理工具描述和回调结果；会话执行命令走 Python RuntimeBridge。 */
    accept(message: Fields) {
      if (message.type === 'tool-result' && typeof message.id === 'string') {
        pending.get(message.id)?.settle(message)
        pending.delete(message.id)
        return
      }
      if (message.type !== 'tool-install' || typeof message.id !== 'string')
        return
      const identifier = message.id
      void (async () => {
        const host = await application
        await host.ready
        const { defineTool } = (await load('@deepseek-ai/dsh-tools')) as {
          defineTool(value: ToolDefinition): ToolDefinition
        }
        const raw = fields(message.tool)
        if (
          typeof raw.id !== 'string' ||
          !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(raw.id) ||
          typeof raw.name !== 'string' ||
          typeof raw.description !== 'string' ||
          !Number.isSafeInteger(raw.revision)
        )
          throw new Error('Invalid tool descriptor')
        const tool: ToolDescriptor = {
          id: raw.id,
          name: raw.name,
          description: raw.description,
          revision: Number(raw.revision),
          parameters: fields(raw.parameters),
          timeoutSeconds:
            typeof raw.timeoutSeconds === 'number'
              ? raw.timeoutSeconds
              : undefined,
        }
        const existing = installed.get(tool.id)
        if (existing && existing.revision !== tool.revision)
          throw new Error('Tool revision already frozen')
        if (!existing) {
          const dispose = host.ctx.tools.register(
            defineTool({
              name: tool.id,
              description: tool.description,
              parameters: tool.parameters,
              output: {
                schema: {
                  type: 'object',
                  properties: { result: { type: 'string', required: true } },
                  additionalProperties: false,
                },
                render: (_args, value) => [
                  { type: 'text', text: value.result },
                ],
              },
              async execute(args, execution) {
                if (!execution.agent || execution.agent.status !== 'running')
                  throw new Error('工具没有运行会话')
                const agent = execution.agent
                const prepared = await invoke(tool, execution, args)
                // 用户确认使用 DSH 原问答机制；等待期不占 Python 工具执行超时。
                if (prepared.confirmation && prepared.plan) {
                  const confirmation = fields(prepared.confirmation)
                  const plan = fields(prepared.plan)
                  const questionId = String(confirmation.receiptId)
                  const ask = () =>
                    host.ctx.userQuestions.ask({
                      agent,
                      signal: execution.signal,
                      questions: [
                        {
                          id: questionId,
                          question: '是否按此方案执行？',
                          detail: String(
                            plan.summary ??
                              plan.title ??
                              '请检查本次方案与输入。',
                          ),
                          intent: {
                            kind: 'plan-review',
                            approve: '确认执行',
                            callId: String(execution.callId),
                          },
                          options: [
                            { label: '确认执行' },
                            { label: '修改方案' },
                          ],
                        },
                      ],
                    })
                  let answer: Awaited<ReturnType<typeof ask>>
                  try {
                    answer = await ask()
                    execution.signal.throwIfAborted()
                  } catch (error) {
                    if (execution.signal.aborted) {
                      // 问答取消后仍需撤销 Python 的待确认方案。独立短限时只用于清理，
                      // 不携带确认执行权限，也不借已取消的执行信号重新发起业务调用。
                      await invoke(
                        tool,
                        { ...execution, signal: AbortSignal.timeout(10000) },
                        {},
                        {
                          phase: 'reject-confirmation',
                          confirmation,
                          cancelledByUser: true,
                        },
                      )
                    }
                    throw error
                  }
                  const decision = answer.answers.find(
                    (item) => item.id === questionId,
                  )
                  const approved =
                    !decision?.custom &&
                    decision?.selected?.length === 1 &&
                    decision.selected[0] === '确认执行'
                  const result = await invoke(
                    tool,
                    execution,
                    {},
                    {
                      phase: approved
                        ? 'confirm-execute'
                        : 'reject-confirmation',
                      confirmation,
                      feedback: decision?.custom ?? '',
                    },
                  )
                  return { result: JSON.stringify(result) }
                }
                return { result: JSON.stringify(prepared) }
              },
              presentCall: () => ({
                card: 'generic',
                title: tool.name,
                kind: 'read',
              }),
            }),
          )
          installed.set(tool.id, { revision: tool.revision, dispose })
        }
        send({ type: 'tool-installed', id: identifier })
      })().catch(() =>
        send({ type: 'tool-installed', id: identifier, error: true }),
      )
    },
  }
}
