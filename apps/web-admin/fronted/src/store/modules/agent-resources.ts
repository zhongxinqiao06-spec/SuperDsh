import { createAgentsApi } from '@/api/agents/agents-api'
import type { Product } from '@/types/console/navigation'
import { sessionController } from '@/store/session-controller'

let preparedGeneration = -1
const preparations = new Map<Product, Promise<unknown>>()

/** 每次登录只共享一次资源初始化，失败允许显式重载重试；不重建用户已删除的示例。 */
export async function loadPreparedAgentResources<T>(
  product: Product,
  signal: AbortSignal,
  loader: () => Promise<T>,
): Promise<T> {
  const generation = sessionController.generation
  if (preparedGeneration !== generation) {
    preparations.clear()
    preparedGeneration = generation
  }
  if (!preparations.has(product)) {
    const promise = createAgentsApi(product)
      .initialize()
      .catch((cause: unknown) => {
        if (preparations.get(product) === promise) preparations.delete(product)
        throw cause
      })
    preparations.set(product, promise)
  }
  await preparations.get(product)
  // 初始化是同身份共享请求，不因单页关闭取消其他消费者；后续读取必须校验原调用仍有效。
  signal.throwIfAborted()
  if (generation !== sessionController.generation)
    throw new Error('账号状态已变化，请重新加载资源')
  return loader()
}
