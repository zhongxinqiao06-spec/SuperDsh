import { ApiError, object } from '../http/api-router.ts'
import type { Row } from '../infrastructure/database.ts'
import type { BusinessAgentService } from './service.ts'
import type { AgentToolContext } from './contracts.ts'
import { parseAgentToolContext } from './tool-context.ts'
import { OfficePlanService } from './office-plans.ts'
import { resolveManagedTool } from './managed-tool.ts'
import { builtinReadTools } from './builtin-read-tools.ts'
import { builtinSourceId } from '../extensions/builtin-tools.ts'
import { validateValue } from '../extensions/validation.ts'
import { SkillRuntime, skillControlTool } from '../skills/runtime.ts'

export async function executeAgentTool(
  service: BusinessAgentService,
  owner: string,
  sessionId: string,
  tool: string,
  args: Row,
  signal: AbortSignal,
  context?: AgentToolContext,
): Promise<Row> {
  signal.throwIfAborted()
  const plans = new OfficePlanService(service)
  const binding = await plans.authorize(owner, sessionId)
  const hostContext = context ? parseAgentToolContext(context) : undefined
  if (
    hostContext &&
    (hostContext.sessionId !== sessionId ||
      hostContext.presetId !== binding.presetId)
  )
    throw new ApiError(403, '业务工具上下文不属于当前会话')
  if (
    hostContext &&
    (hostContext.bindingVersion ?? 1) !== (binding.bindingVersion ?? 1)
  )
    throw new ApiError(409, '智能体绑定已更新，旧请求不能继续执行')
  const skills = new SkillRuntime(service)
  if (tool === skillControlTool) {
    if (!hostContext) throw new ApiError(403, '技能只能通过当前 Host 执行')
    return skills.control(owner, binding, args, hostContext)
  }
  const registered = await resolveManagedTool(service, owner, binding, tool)
  if (skills.enabled(binding) && !hostContext)
    throw new ApiError(403, '技能工具只能通过真实 Host 调用')
  if (registered.descriptor.mode === 'read') {
    let input = args
    if (typeof args.argumentsJson === 'string') {
      try {
        input = object(JSON.parse(args.argumentsJson))
      } catch {
        throw new ApiError(422, '工具参数必须是 JSON 对象')
      }
    }
    validateValue(registered.descriptor.inputSchema, input, '工具参数')
    const ticket = hostContext
      ? await skills.beforeTool(owner, binding, tool, {
          ...hostContext,
          phase: 'inspect',
        })
      : null
    const bounded = ticket
      ? AbortSignal.any([
          signal,
          AbortSignal.timeout(ticket.timeoutSeconds * 1000),
        ])
      : signal
    let result: Row
    try {
      result =
        registered.implementation.sourceId === builtinSourceId
          ? await builtinReadTools[registered.implementation.toolId]!(
              service,
              owner,
              binding,
              input,
              registered.configuration,
              bounded,
            )
          : await service.options.extensions!.invoke(
              registered.implementation,
              input,
              registered.configuration,
              bounded,
            )
      await plans.authorize(owner, sessionId)
    } catch (cause) {
      const error = bounded.aborted
        ? signal.aborted
          ? new ApiError(499, '技能执行已取消')
          : new ApiError(504, '技能阶段执行超时')
        : cause
      if (ticket)
        await skills.afterTool(owner, binding, ticket, undefined, error)
      throw error
    }
    if (ticket) await skills.afterTool(owner, binding, ticket, result)
    return result
  }
  if (!hostContext)
    throw new ApiError(403, '工具操作只能通过真实 Host 调用并确认')
  const ticket = await skills.beforeTool(owner, binding, tool, hostContext)
  const contextWithSkill = ticket
    ? {
        ...hostContext,
        skillRunId: ticket.runId,
        skillRevision: ticket.revision,
      }
    : hostContext
  const bounded = ticket
    ? AbortSignal.any([
        signal,
        AbortSignal.timeout(ticket.timeoutSeconds * 1000),
      ])
    : signal
  let result: Row
  try {
    result =
      hostContext.phase === 'execute'
        ? await plans.execute(owner, binding, tool, contextWithSkill, bounded)
        : await plans.prepare(
            owner,
            binding,
            tool,
            args,
            contextWithSkill,
            bounded,
          )
  } catch (cause) {
    const error = bounded.aborted
      ? signal.aborted
        ? signal.reason instanceof ApiError
          ? signal.reason
          : new ApiError(499, '技能执行已取消')
        : new ApiError(504, '技能阶段执行超时')
      : cause
    if (ticket) await skills.afterTool(owner, binding, ticket, undefined, error)
    throw error
  }
  if (ticket) await skills.afterTool(owner, binding, ticket, result)
  return result
}
