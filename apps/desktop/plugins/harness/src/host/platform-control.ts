/** Product lifecycle controls over the existing Agent registry; no execution queue. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '../managed-models.ts'

/** Include between-turn maintenance, whose public Agent status remains idle. */
export async function inspectPlatformTasks(ctx: Context): Promise<boolean> {
  const agents = ctx.get('agents')?.list() ?? []
  if (agents.some((agent) => agent.status === 'running')) return true
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.all(agents.map((agent) => agent.whenIdle())).then(() => false),
      new Promise<true>((resolve) => {
        timer = setTimeout(() => resolve(true), 0)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Cancel queued/steering input and await real convergence before replacing credentials. */
export async function stopPlatformTasks(ctx: Context): Promise<boolean> {
  const agents = ctx.get('agents')?.list() ?? []
  for (const agent of agents) agent.cancel({ kind: 'user' })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.all(agents.map((agent) => agent.whenIdle())),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error('任务未能及时停止，已保留当前账号，请稍后重试。')),
          15_000,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
  if (await inspectPlatformTasks(ctx))
    throw new Error('仍有运行中的任务，已保留当前账号，请停止后重试。')
  return false
}

export async function refreshPlatformModels(ctx: Context): Promise<void> {
  const service = ctx.get('superdshManagedModels')
  if (!service) throw new Error('平台模型服务尚未就绪')
  await service.refresh()
}
