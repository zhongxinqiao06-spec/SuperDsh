import { Ajv } from 'ajv'
import { ApiError } from '../http/api-router.ts'
import type {
  ExtensionManifest,
  JsonSchema,
  ToolImplementation,
} from '@superdsh/core/contracts/extensions'
import { permissions } from '../identity/permissions.ts'

const ajv = new Ajv({ allErrors: false, strict: false, validateFormats: false })
const idPattern = /^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$/u
export function extensionId(value: unknown, label = '标识'): string {
  if (typeof value !== 'string' || !idPattern.test(value))
    throw new ApiError(422, `${label}需为字母开头的稳定标识`)
  return value
}
export function extensionVersion(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(value)
  )
    throw new ApiError(422, '扩展版本需为 SemVer，如 1.0.0')
  return value
}
export function packagePath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 240 ||
    /[\\:\x00-\x1f]/u.test(value) ||
    value.startsWith('/') ||
    value
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part) ||
          /[. ]$/u.test(part),
      )
  )
    throw new ApiError(422, '扩展文件必须使用包内相对路径')
  return value
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApiError(422, `${label}必须是对象`)
  return value as Record<string, unknown>
}
function string(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new ApiError(422, `${label}不能为空且不能超过 ${max} 字符`)
  return value.trim()
}
export function validateSchema(value: unknown, label: string): JsonSchema {
  const schema = object(value, label)
  if (schema.type !== 'object' || JSON.stringify(schema).length > 32000)
    throw new ApiError(422, `${label}必须是有界的 object JSON Schema`)
  const visit = (node: unknown, depth = 0) => {
    if (depth > 16) throw new ApiError(422, `${label}嵌套过深`)
    if (!node || typeof node !== 'object') return
    for (const [key, item] of Object.entries(node)) {
      if (
        [
          '$ref',
          '$dynamicRef',
          '$recursiveRef',
          '__proto__',
          'constructor',
          'prototype',
        ].includes(key)
      )
        throw new ApiError(422, `${label}不能使用引用或保留属性`)
      if (key === 'pattern' || key === 'patternProperties')
        throw new ApiError(
          422,
          `${label}不支持扩展提供的正则表达式，请使用枚举、长度和范围限制`,
        )
      visit(item, depth + 1)
    }
  }
  visit(schema)
  try {
    ajv.compile(schema)
  } catch {
    throw new ApiError(422, `${label}无效`)
  }
  return schema
}
export function validateValue(
  schema: JsonSchema,
  value: unknown,
  label: string,
) {
  if (JSON.stringify(value)?.length > 4 * 1024 * 1024)
    throw new ApiError(413, `${label}超过大小限制`)
  const validate = ajv.compile(schema)
  if (!validate(value)) {
    const error = validate.errors?.[0]
    throw new ApiError(
      422,
      `${label}不符合 Schema：${error?.instancePath || '/'} ${error?.message || ''}`,
    )
  }
}
export function validateTool(value: unknown): ToolImplementation {
  const input = object(value, '工具')
  const mode = input.mode
  if (mode !== 'read' && mode !== 'action' && mode !== 'office')
    throw new ApiError(422, '工具执行方式需为 read、action 或 office')
  if (
    !Array.isArray(input.permissions) ||
    input.permissions.some((p) => typeof p !== 'string' || !permissions[p])
  )
    throw new ApiError(422, '工具必须声明有效的产品权限')
  if (
    !Array.isArray(input.artifactTypes) ||
    input.artifactTypes.some((p) => typeof p !== 'string' || p.length > 150)
  )
    throw new ApiError(422, '工具成果类型无效')
  const timeout = input.timeoutSeconds ?? 120
  if (
    typeof timeout !== 'number' ||
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > 600
  )
    throw new ApiError(422, '工具超时需为 1–600 秒')
  const configurationSchema = validateSchema(
    input.configurationSchema ?? {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    '配置 Schema',
  )
  const checkSecret = (value: unknown, path: string[] = []) => {
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (
        key === 'writeOnly' &&
        child === true &&
        (path.length !== 2 || path[0] !== 'properties')
      )
        throw new ApiError(
          422,
          '凭据字段必须放在配置 Schema 顶层 properties 内',
        )
      checkSecret(child, [...path, key])
    }
  }
  checkSecret(configurationSchema)
  const presets = input.configurationPresets
  if (presets !== undefined && (!Array.isArray(presets) || presets.length > 30))
    throw new ApiError(422, '工具配置预设最多 30 项')
  const configurationPresets = (presets as unknown[] | undefined)?.map(
    (raw) => {
      const preset = object(raw, '配置预设'),
        values = object(preset.values, '预设配置')
      validateValue(
        { ...configurationSchema, required: [] },
        values,
        '预设配置',
      )
      const properties = object(
        configurationSchema.properties ?? {},
        '配置字段',
      )
      for (const [key, property] of Object.entries(properties))
        if (
          object(property, '配置字段').writeOnly === true &&
          values[key] !== undefined
        )
          throw new ApiError(422, '配置预设不能包含凭据')
      return {
        id: extensionId(preset.id),
        name: string(preset.name, '预设名称', 100),
        version: extensionVersion(preset.version),
        values,
      }
    },
  )
  return {
    id: extensionId(input.id, '工具标识'),
    name: string(input.name, '工具名称', 100),
    description: string(input.description, '工具说明', 4000),
    mode,
    inputSchema: validateSchema(input.inputSchema, '输入 Schema'),
    outputSchema:
      input.outputSchema === undefined
        ? undefined
        : validateSchema(input.outputSchema, '输出 Schema'),
    configurationSchema,
    permissions: [...new Set(input.permissions as string[])],
    artifactTypes: input.artifactTypes as string[],
    timeoutSeconds: timeout,
    guide:
      input.guide === undefined
        ? undefined
        : string(input.guide, '工具指引', 24000),
    configurationPresets,
  }
}
export function validateManifest(value: unknown): ExtensionManifest {
  const input = object(value, '扩展清单')
  if (input.schemaVersion !== 1) throw new ApiError(422, '不支持此扩展协议版本')
  if (!['node', 'python', 'mcp-stdio'].includes(String(input.runtime)))
    throw new ApiError(422, '扩展运行时不受支持')
  if (
    !Array.isArray(input.tools) ||
    !input.tools.length ||
    input.tools.length > 100
  )
    throw new ApiError(422, '扩展需提供 1–100 个工具')
  const tools = input.tools.map(validateTool)
  if (new Set(tools.map((tool) => tool.id)).size !== tools.length)
    throw new ApiError(422, '包内工具标识重复')
  const skills = input.skills === undefined ? [] : input.skills
  if (!Array.isArray(skills) || skills.length > 100)
    throw new ApiError(422, '技能清单无效')
  return {
    schemaVersion: 1,
    id: extensionId(input.id, '扩展标识'),
    name: string(input.name, '扩展名称', 100),
    description: string(input.description, '扩展说明', 2000),
    license: string(input.license, '许可', 200),
    version: extensionVersion(input.version),
    runtime: input.runtime as ExtensionManifest['runtime'],
    entrypoint: packagePath(input.entrypoint),
    tools,
    skills: skills.map((raw) => {
      const skill = object(raw, '技能')
      if (
        !Array.isArray(skill.requiredToolIds) ||
        skill.requiredToolIds.some(
          (id) => !tools.some((tool) => tool.id === id),
        )
      )
        throw new ApiError(422, '包内技能依赖未声明的工具')
      return {
        id: extensionId(skill.id),
        name: string(skill.name, '技能名称', 100),
        description: string(skill.description, '技能说明', 1000),
        entrypoint: packagePath(skill.entrypoint),
        requiredToolIds: skill.requiredToolIds as string[],
      }
    }),
  }
}
