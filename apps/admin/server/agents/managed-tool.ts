import { ApiError, object, requiredText, text } from '../http/api-router.ts'
import { createHash } from 'node:crypto'
import { requirePermission } from '../conversations/store.ts'
import { builtinBinding } from '../extensions/service.ts'
import { builtinSourceId } from '../extensions/builtin-tools.ts'
import { validateValue } from '../extensions/validation.ts'
import type { BusinessAgentService } from './service.ts'
import type { AgentBinding } from './contracts.ts'
import type { ResolvedOfficeSource } from './office-sources.ts'
import { officeWork } from './office-worker-client.ts'
import { imageToolWork } from '../extensions/image-tool.ts'

const serverTools = { image_generate: imageToolWork } as const

export async function resolveManagedTool(
  service: BusinessAgentService,
  owner: string,
  binding: AgentBinding,
  tool: string,
) {
  if (!binding.definition.toolIds.includes(tool))
    throw new ApiError(403, '智能体未授权此工具')
  const configured = binding.tools?.find((item) => item.id === tool)
  const registered = service.options.extensions
    ? await service.options.extensions.bind(configured?.implementation, tool)
    : builtinBinding(tool)
  const account = await service.options.getAccount(owner)
  for (const permission of registered.descriptor.permissions)
    requirePermission(account, permission)
  const secrets = service.options.extensions
    ? await service.options.extensions.secrets(
        binding.resourceOwnerId || owner,
        tool,
        configured?.version,
      )
    : {}
  const configuration = { ...configured?.settings, ...secrets }
  let legacyCapabilityBinding:
    import('@superdsh/core/contracts/platform').CapabilityBinding | undefined
  if (
    registered.implementation.sourceId === builtinSourceId &&
    registered.implementation.toolId === 'image_generate' &&
    configuration.baseUrl &&
    configuration.model &&
    service.options.modelConfigurations
  )
    legacyCapabilityBinding =
      await service.options.modelConfigurations.importLegacyImage(
        binding.resourceOwnerId || owner,
        tool,
        configured?.version || 1,
        configuration,
        text(configuration.apiKey),
      )
  validateValue(
    registered.descriptor.configurationSchema,
    configuration,
    '工具配置',
  )
  return { ...registered, configuration, legacyCapabilityBinding }
}

export async function managedToolWork(
  service: BusinessAgentService,
  owner: string,
  binding: AgentBinding,
  tool: string,
  operation: 'inspect' | 'prepare' | 'generate',
  sources: ResolvedOfficeSource[],
  document: unknown,
  signal: AbortSignal,
  executionKey?: string,
): Promise<Record<string, unknown>> {
  const registered = await resolveManagedTool(service, owner, binding, tool)
  if (registered.implementation.sourceId === builtinSourceId) {
    if (
      ['image_generate', 'vision_analyze'].includes(
        registered.implementation.toolId,
      ) &&
      service.options.capabilities &&
      service.options.modelConfigurations
    ) {
      const capabilityBinding =
        binding.capabilityBindings?.[tool] ?? registered.legacyCapabilityBinding
      if (!capabilityBinding)
        throw new ApiError(
          422,
          '此会话未绑定生图模型。请先在多模态模型管理中设置默认值或工具的模型配置，再重新选择智能体；不会自动替换费用来源。',
        )
      const resolved = await service.options.modelConfigurations.resolve(
        await service.options.getAccount(owner),
        capabilityBinding,
      )
      if (operation === 'inspect')
        return {
          configured: true,
          model: resolved.configuration.name,
          parameters: resolved.configuration.parameters,
          referenceImageLimit: resolved.configuration.parameters.maxImages || 4,
          note: '参考图从授权输入资料中选择；一次生成一张配图。',
        }
      const input = object(document)
      const plan = {
        title: requiredText(input.title, '配图标题', 100),
        prompt: requiredText(input.prompt, '生图提示词', 12000),
        purpose: text(input.purpose).slice(0, 500),
        size: input.size || resolved.configuration.parameters.size,
        imageCount: 1,
        capabilityBinding,
      }
      if (operation === 'prepare')
        return {
          document: plan,
          preflight: {
            diagnostics: [
              `将使用 ${resolved.configuration.name} 执行${capabilityBinding.capability === 'image.generate' ? '单张配图生成' : '视觉理解'}；可能产生费用，不会自动重试或切换供应商。`,
            ],
          },
        }
      if (
        input.capabilityBinding === undefined &&
        registered.legacyCapabilityBinding &&
        registered.implementation.version === '2.0.0'
      ) {
        // Historical confirmed plans retain their exact legacy tool credential and version.
      } else if (
        JSON.stringify(input.capabilityBinding) !==
        JSON.stringify(capabilityBinding)
      )
        throw new ApiError(409, '方案绑定的模型版本与会话不一致，请重新确认')
      const result = await service.options.capabilities.execute(
        owner,
        binding.sessionId,
        capabilityBinding,
        executionKey ||
          createHash('sha256').update(JSON.stringify(plan)).digest('hex'),
        plan,
        sources
          .filter((source) => source.reference.role === 'image')
          .map((source) => ({
            content: source.file.content,
            mediaType:
              source.file.filename.toLowerCase().endsWith('.jpg') ||
              source.file.filename.toLowerCase().endsWith('.jpeg')
                ? 'image/jpeg'
                : source.file.filename.toLowerCase().endsWith('.webp')
                  ? 'image/webp'
                  : 'image/png',
          })),
        signal,
      )
      if (capabilityBinding.capability === 'vision.analyze')
        return { toolResult: result }
      const file = await service.options.files.library!.readBuffer(
        owner,
        text(result.fileId),
      )
      return {
        content: file.content,
        filename: file.entry.name,
        mediaType: file.entry.mediaType,
        summary: result,
        diagnostics: [
          {
            code: 'generated-image',
            message: '已保存供应商生成素材；未进行视觉模型审美审查。',
          },
        ],
      }
    }
    const serverTool =
      serverTools[registered.implementation.toolId as keyof typeof serverTools]
    if (serverTool)
      return serverTool(
        operation,
        document,
        registered.configuration,
        service.options.extensions?.options.allowedOrigins ?? '',
        signal,
      )
    const configuredDocument =
      document && typeof document === 'object' && !Array.isArray(document)
        ? {
            ...document,
            ...(registered.configuration.designTheme &&
            (Array.isArray(object(document).slides) ||
              Array.isArray(object(document).sections) ||
              Array.isArray(object(document).nodes))
              ? {
                  designTheme:
                    object(document).designTheme ??
                    registered.configuration.designTheme,
                }
              : {}),
            ...(registered.configuration.companyName &&
            (Array.isArray(object(document).slides) ||
              Array.isArray(object(document).sections))
              ? {
                  brand: {
                    company: registered.configuration.companyName,
                    ...object(object(document).brand ?? {}),
                  },
                }
              : {}),
          }
        : document
    return officeWork(
      operation,
      registered.implementation.toolId,
      sources,
      configuredDocument,
      signal,
    )
  }
  if (operation === 'inspect')
    return {
      inputSchema: registered.descriptor.inputSchema,
      sources: sources.map((source) => source.reference),
      description: registered.descriptor.description,
    }
  const argumentsObject = object(document)
  const args = object(argumentsObject.arguments ?? document)
  validateValue(registered.descriptor.inputSchema, args, '工具参数')
  if (operation === 'prepare')
    return {
      document: { title: registered.descriptor.name, arguments: args },
      preflight: { diagnostics: [] },
    }
  if (!service.options.extensions) throw new ApiError(503, '扩展执行服务不可用')
  const result = await service.options.extensions.invoke(
    registered.implementation,
    args,
    registered.configuration,
    signal,
    {
      sessionId: binding.sessionId,
      bindingVersion: binding.bindingVersion ?? 1,
      sources: sources.map((source) => ({
        reference: { ...source.reference },
        contentBase64: source.file.content.toString('base64'),
      })),
    },
  )
  return { toolResult: result.structuredContent ?? result }
}
