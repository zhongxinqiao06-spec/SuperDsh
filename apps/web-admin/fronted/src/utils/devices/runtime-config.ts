import type {
  DeviceRuntime,
  RuntimeDraft,
  RuntimeSchema,
  RuntimeType,
} from '@/types/devices/devices'

/** JSON 领域值深拷贝，避免编辑 Proxy 或嵌套字段修改服务器快照。 */
export function copyConfiguration(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyConfiguration)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        copyConfiguration(item),
      ]),
    )
  return value
}
/** 新实例使用类型默认值；现有配置独立复制并保留服务端修订。 */
export function runtimeDraft(
  type?: RuntimeType,
  runtime?: DeviceRuntime,
): RuntimeDraft {
  const config = copyConfiguration(runtime?.config ?? type?.defaults ?? {})
  return {
    name: runtime?.name ?? type?.displayName ?? '',
    runtimeType: type?.runtimeType ?? runtime?.runtimeType ?? '',
    config:
      config && typeof config === 'object' && !Array.isArray(config)
        ? (config as Record<string, unknown>)
        : {},
    active: runtime?.active ?? false,
  }
}
/** Schema 必填提示只作用户反馈，实际配置仍由设备验证服务判定。 */
export function configurationErrors(
  schema: RuntimeSchema | null | undefined,
  config: Record<string, unknown>,
  prefix = '',
): string[] {
  const errors: string[] = []
  for (const key of schema?.required ?? [])
    if (config[key] === undefined || config[key] === null || config[key] === '')
      errors.push(`${prefix}${schema?.properties?.[key]?.title ?? key}不能为空`)
  for (const [key, field] of Object.entries(schema?.properties ?? {})) {
    const value = config[key],
      label = `${prefix}${field.title ?? key}`
    if (value === undefined || value === null || value === '') continue
    if (field.type === 'array' && !Array.isArray(value))
      errors.push(`${label}必须是有效数组`)
    if (
      field.type === 'object' &&
      (typeof value !== 'object' || Array.isArray(value))
    )
      errors.push(`${label}必须是有效对象`)
    if (
      field.type === 'object' &&
      typeof value === 'object' &&
      !Array.isArray(value)
    )
      errors.push(
        ...configurationErrors(
          field,
          value as Record<string, unknown>,
          `${label} / `,
        ),
      )
    if (field.enum && !field.enum.some((item) => item === value))
      errors.push(`${label}不是允许的选项`)
    if (
      (field.type === 'number' || field.type === 'integer') &&
      (typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (field.type === 'integer' && !Number.isInteger(value)))
    )
      errors.push(`${label}必须是有效数字`)
    if (
      typeof value === 'number' &&
      ((field.minimum !== undefined && value < field.minimum) ||
        (field.maximum !== undefined && value > field.maximum))
    )
      errors.push(`${label}超出允许范围`)
  }
  return errors
}

/** 状态来源是设备实时报文；未知状态明确保留，不假定为已运行。 */
export function runtimeStatus(status: string): string {
  return (
    (
      {
        running: '运行中',
        stopped: '已停止',
        starting: '启动中',
        stopping: '停止中',
        configuring: '配置中',
        available: '可用',
        unavailable: '不可用',
        error: '发生错误',
        unknown: '未知',
        validating: '校验中',
        discovering: '发现中',
      } as Record<string, string>
    )[status] ?? status
  )
}
