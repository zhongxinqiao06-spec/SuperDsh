import { workbenchCell } from '@/features/workbench/memory'
import type { AgentDefinition } from './api'

/** Stage a real workspace task; never auto-send or replace an existing draft. */
export function stageAgentTrial(agent: AgentDefinition) {
  if (!agent.published) return 'unpublished' as const
  if (workbenchCell('new-session/creating', false).get()) return 'busy' as const
  if (
    workbenchCell('new-session/prompt', '').get().trim() ||
    workbenchCell<unknown[]>('new-session/attachments', []).get().length
  )
    return 'draft' as const
  workbenchCell('new-session/agent-definition', '').set(agent.id)
  workbenchCell('new-session/agent-trial', '').set(agent.id)
  workbenchCell('new-session/prompt', '').set(
    agent.recommendedPrompts?.[0] ?? '',
  )
  workbenchCell('last-workbench-hash', '#/workspace').set('#/workspace')
  window.location.hash = '#/workspace'
  return 'ready' as const
}
