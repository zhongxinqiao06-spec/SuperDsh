import { string } from './platform-model.ts'
import type { useNewSessionOptions } from './use-new-session-options.ts'
import { PlatformSelect } from './PlatformSelect.tsx'
export function NewSessionOptions({
  options,
  disabled,
}: {
  options: ReturnType<typeof useNewSessionOptions>
  disabled: boolean
}) {
  return (
    <div className="platformActions">
      <PlatformSelect
        label="新会话模型"
        placeholder="请选择模型"
        value={options.model}
        disabled={disabled}
        onChange={options.setModel}
        side="top"
        options={options.models.map((row) => ({
          value: string(row.selectionId) || string(row.id),
          label: string(row.displayName) || string(row.name) || string(row.id),
        }))}
      />
      <PlatformSelect
        label="新会话权限"
        placeholder="请选择权限"
        value={options.permission}
        disabled={disabled}
        onChange={options.setPermission}
        side="top"
        options={options.permissions.map((row) => ({
          value: string(row.selectionId) || string(row.id),
          label: string(row.displayName) || string(row.id),
        }))}
      />
      {options.error && <p role="alert">{options.error}</p>}
    </div>
  )
}
