'use client'

import type {
  ExtensionSource,
  ToolImplementationRef,
} from '@superdsh/core/contracts/extensions'
import type { AgentTool } from '@/features/agents/resources-api'
import { FieldLabel, selectClass } from './controls'
import {
  configurationDefaults,
  ToolConfigurationFields,
} from './tool-configuration-fields'

const identity = (ref: ToolImplementationRef) =>
  `${ref.sourceId}@${ref.version}:${ref.toolId}`

export function ToolImplementationEditor({
  sources,
  implementation,
  settings,
  existing,
  onSelect,
  onSettings,
}: {
  sources: ExtensionSource[]
  implementation?: ToolImplementationRef
  settings: AgentTool['settings']
  existing?: AgentTool
  onSelect(ref: ToolImplementationRef, defaults: AgentTool['settings']): void
  onSettings(value: AgentTool['settings']): void
}) {
  const choices = sources
    .filter((source) => source.enabled)
    .flatMap((source) =>
      source.tools.map((descriptor) => ({
        descriptor,
        label: `${source.name} / ${descriptor.name} · ${source.activeVersion}`,
        implementation: {
          sourceId: source.id,
          version: source.activeVersion,
          toolId: descriptor.id,
          digest:
            source.versions.find(
              (version) => version.version === source.activeVersion,
            )?.digest ?? '',
        },
      })),
    )
  const selectedRef =
    implementation ??
    existing?.implementation ??
    choices.find((item) => item.descriptor.id === existing?.id)?.implementation
  const selected = choices.find(
    (item) =>
      selectedRef && identity(item.implementation) === identity(selectedRef),
  )
  const descriptor = selected?.descriptor ?? existing?.descriptor
  return (
    <div className="space-y-4">
      <FieldLabel title="工具实现与版本">
        <select
          className={selectClass}
          required
          value={selectedRef ? identity(selectedRef) : ''}
          onChange={(event) => {
            const item = choices.find(
              (entry) => identity(entry.implementation) === event.target.value,
            )
            if (item)
              onSelect(
                item.implementation,
                configurationDefaults(item.descriptor.configurationSchema),
              )
          }}
        >
          <option value="">请选择已安装并启用的工具</option>
          {selectedRef && !selected && (
            <option value={identity(selectedRef)}>
              {existing?.name ?? selectedRef.toolId} · 已绑定版本{' '}
              {selectedRef.version}
            </option>
          )}
          {choices.map((item) => (
            <option
              key={identity(item.implementation)}
              value={identity(item.implementation)}
            >
              {item.label}
            </option>
          ))}
        </select>
      </FieldLabel>
      {descriptor && (
        <>
          <p className="rounded-lg border p-3 text-sm text-muted-foreground">
            {descriptor.description}
            <span className="mt-1 block text-xs">
              权限：{descriptor.permissions.join('、')} · 超时：
              {descriptor.timeoutSeconds} 秒
            </span>
          </p>
          {!!descriptor.configurationPresets?.length && (
            <FieldLabel title="从预设复制配置">
              <select
                className={selectClass}
                value=""
                onChange={(event) => {
                  const preset = descriptor.configurationPresets?.find(
                    (item) => item.id === event.target.value,
                  )
                  if (preset) onSettings({ ...settings, ...preset.values })
                }}
              >
                <option value="">选择后可继续修改</option>
                {descriptor.configurationPresets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name} · {preset.version}
                  </option>
                ))}
              </select>
            </FieldLabel>
          )}
          <ToolConfigurationFields
            key={selectedRef ? identity(selectedRef) : 'legacy'}
            schema={descriptor.configurationSchema}
            value={settings}
            configuredSecrets={existing?.configuredSecrets}
            onChange={onSettings}
          />
        </>
      )}
    </div>
  )
}
