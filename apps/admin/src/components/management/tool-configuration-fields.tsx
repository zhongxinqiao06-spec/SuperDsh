'use client'

import * as React from 'react'
import type { JsonSchema } from '@superdsh/core/contracts/extensions'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { FieldLabel, selectClass, useManagementResource } from './controls'
import { apiClient } from '@/lib/api'
import type { ModelConfiguration } from '@superdsh/core/contracts/platform'

function CapabilityConfigurationField({
  capability,
  value,
  onChange,
}: {
  capability: string
  value: string
  onChange(value: string | undefined): void
}) {
  const resource = useManagementResource(
    'capability-binding:' + capability,
    () =>
      apiClient.get<{ configurations: ModelConfiguration[] }>(
        '/models/capabilities',
      ),
  )
  const choices =
    resource.data?.configurations.filter(
      (item) => item.capability === capability,
    ) ?? []
  return (
    <>
      <select
        className={selectClass}
        value={value}
        onChange={(event) => onChange(event.target.value || undefined)}
      >
        <option value="">新会话使用全局默认</option>
        {value && !choices.some((item) => item.id === value) && (
          <option value={value}>当前配置不可用：{value}</option>
        )}
        {choices.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name} · {item.modelId} · v{item.revision}
          </option>
        ))}
      </select>
      {resource.error && (
        <span role="alert" className="text-xs text-destructive">
          {resource.error}
        </span>
      )}
    </>
  )
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function StructuredSetting({
  value,
  onChange,
  required,
  label,
}: {
  value: unknown
  onChange(value: unknown): void
  required: boolean
  label: string
}) {
  const [draft, setDraft] = React.useState(
    value === undefined ? '' : JSON.stringify(value, null, 2),
  )
  const lastValue = React.useRef(value)
  React.useEffect(() => {
    if (value !== lastValue.current) {
      lastValue.current = value
      setDraft(value === undefined ? '' : JSON.stringify(value, null, 2))
    }
  }, [value])
  return (
    <Textarea
      aria-label={label}
      rows={6}
      required={required}
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value)
        try {
          const parsed: unknown = event.target.value.trim()
            ? JSON.parse(event.target.value)
            : undefined
          event.target.setCustomValidity('')
          lastValue.current = parsed
          onChange(parsed)
        } catch {
          event.target.setCustomValidity('请输入有效的 JSON 配置')
        }
      }}
    />
  )
}

export function ToolConfigurationFields({
  schema,
  value,
  configuredSecrets = [],
  onChange,
}: {
  schema: JsonSchema
  value: Record<string, unknown>
  configuredSecrets?: string[]
  onChange(value: Record<string, unknown>): void
}) {
  const properties = record(schema.properties)
  const update = (key: string, entry: unknown) => {
    const next = { ...value }
    if (entry === undefined) delete next[key]
    else next[key] = entry
    onChange(next)
  }
  return (
    <div className="space-y-4">
      {Object.entries(properties).map(([key, raw]) => {
        const field = record(raw)
        const label = typeof field.title === 'string' ? field.title : key
        const secret = field.writeOnly === true
        const required =
          Array.isArray(schema.required) &&
          schema.required.includes(key) &&
          !(secret && configuredSecrets.includes(key))
        const current = value[key]
        return (
          <FieldLabel key={key} title={label}>
            {typeof field['x-superdsh-capability'] === 'string' ? (
              <CapabilityConfigurationField
                capability={field['x-superdsh-capability']}
                value={String(current ?? '')}
                onChange={(entry) => update(key, entry)}
              />
            ) : Array.isArray(field.enum) ? (
              <select
                className={selectClass}
                aria-label={label}
                required={required}
                value={String(current ?? '')}
                onChange={(event) =>
                  update(key, event.target.value || undefined)
                }
              >
                <option value="">请选择</option>
                {field.enum.map((item) => (
                  <option key={String(item)} value={String(item)}>
                    {String(item)}
                  </option>
                ))}
              </select>
            ) : field.type === 'boolean' ? (
              <span className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={current === true}
                  onChange={(event) => update(key, event.target.checked)}
                />
                启用
              </span>
            ) : field.type === 'object' ||
              field.type === 'array' ||
              !field.type ? (
              <StructuredSetting
                key={key}
                value={current}
                required={required}
                label={label}
                onChange={(entry) => update(key, entry)}
              />
            ) : (
              <Input
                aria-label={label}
                type={
                  secret
                    ? 'password'
                    : field.type === 'integer' || field.type === 'number'
                      ? 'number'
                      : 'text'
                }
                autoComplete={secret ? 'new-password' : undefined}
                required={required}
                min={
                  typeof field.minimum === 'number' ? field.minimum : undefined
                }
                max={
                  typeof field.maximum === 'number' ? field.maximum : undefined
                }
                step={
                  field.type === 'integer'
                    ? 1
                    : field.type === 'number'
                      ? 'any'
                      : undefined
                }
                maxLength={
                  typeof field.maxLength === 'number'
                    ? field.maxLength
                    : undefined
                }
                value={current === undefined ? '' : String(current)}
                placeholder={
                  secret && configuredSecrets.includes(key)
                    ? '已设置；留空保留，输入新值替换'
                    : ''
                }
                onChange={(event) =>
                  update(
                    key,
                    event.target.value === ''
                      ? undefined
                      : field.type === 'integer' || field.type === 'number'
                        ? Number(event.target.value)
                        : event.target.value,
                  )
                }
              />
            )}
            {typeof field.description === 'string' && (
              <span className="text-xs text-muted-foreground">
                {field.description}
              </span>
            )}
            {secret && configuredSecrets.includes(key) && (
              <button
                type="button"
                className="text-xs text-destructive"
                onClick={() => update(key, '')}
              >
                清除已保存凭据
              </button>
            )}
          </FieldLabel>
        )
      })}
    </div>
  )
}

export function configurationDefaults(schema: JsonSchema) {
  return Object.fromEntries(
    Object.entries(record(schema.properties))
      .filter(
        ([, value]) =>
          record(value).default !== undefined &&
          record(value).writeOnly !== true,
      )
      .map(([key, value]) => [key, record(value).default]),
  )
}
