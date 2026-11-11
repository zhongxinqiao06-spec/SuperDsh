import { sessionController } from '@/store/session-controller'

/** 待试用草稿与当前会话隔离；只暂存选择，绝不在导航时自动发出任务。 */
export interface AgentTrial {
  agentId: string
  prompt: string
  generation: number
}

let pending: AgentTrial | null = null

/** 智能体页面通过该公开用例提交独立草稿，不覆盖工作台已有输入。 */
export function stageAgentTrial(agentId: string, prompt = ''): void {
  pending = { agentId, prompt, generation: sessionController.generation }
}

/** 工作台一次领取试用请求；跨账号代际的草稿立即丢弃。 */
export function consumeAgentTrial(): AgentTrial | null {
  const value = pending
  pending = null
  return value?.generation === sessionController.generation ? value : null
}
