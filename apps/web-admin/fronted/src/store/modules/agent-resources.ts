import { agentsApi } from '@/api/agents/agents-api'
import { sessionController } from '@/store/session-controller'

let preparation: { generation: number; promise: Promise<unknown> } | null = null

/** 每次登录只共享一次资源初始化，失败允许显式重载重试；不重建用户已删除的示例。 */
export async function loadPreparedAgentResources<T>(
  signal: AbortSignal,
  loader: () => Promise<T>,
): Promise<T> {
  const generation = sessionController.generation
  if (preparation?.generation !== generation) {
    const promise = agentsApi.initialize().catch((cause: unknown) => {
      if (preparation?.promise === promise) preparation = null
      throw cause
    })
    preparation = { generation, promise }
  }
  await preparation.promise
  // 初始化是同身份共享请求，不因单页关闭取消其他消费者；后续读取必须校验原调用仍有效。
  signal.throwIfAborted()
  if (generation !== sessionController.generation)
    throw new Error('账号状态已变化，请重新加载资源')
  return loader()
}
