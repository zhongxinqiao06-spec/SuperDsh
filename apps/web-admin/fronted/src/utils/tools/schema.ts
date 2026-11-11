import type { JsonSchema } from '@/types/tools/tools'
/** 本地Schema展开有深度限制；配置类型仍由后端JSON Schema做权威校验。 */
export function resolveSchema(
  schema: JsonSchema,
  root = schema,
  depth = 0,
): JsonSchema {
  if (depth > 16) return schema
  let value = { ...schema }
  if (schema.$ref?.startsWith('#/$defs/')) {
    const key = schema.$ref.slice(8).replaceAll('~1', '/').replaceAll('~0', '~')
    const target = root.$defs?.[key]
    if (target) value = { ...resolveSchema(target, root, depth + 1), ...schema }
  }
  for (const part of schema.allOf ?? []) {
    const next = resolveSchema(part, root, depth + 1)
    value = {
      ...next,
      ...value,
      properties: { ...next.properties, ...value.properties },
      required: [
        ...new Set([...(next.required ?? []), ...(value.required ?? [])]),
      ],
    }
  }
  return value
}
export function configurationDefaults(
  schema: JsonSchema,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(
    resolveSchema(schema).properties ?? {},
  ))
    if (!field.writeOnly && field.default !== undefined)
      result[key] = structuredClone(field.default)
  return result
}
export function schemaObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
