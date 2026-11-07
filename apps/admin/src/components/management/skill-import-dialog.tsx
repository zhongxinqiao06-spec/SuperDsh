'use client'

import { useState } from 'react'
import { agentSkillsApi, type AgentTool } from '@/features/agents/resources-api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ManagementDialog } from './presentation'
import { FieldLabel } from './controls'
import { ResourceState, selectClass, useManagementResource } from './controls'
import { extensionsApi } from '@/features/agents/extensions-api'

export function SkillImportDialog({
  tools,
  onClose,
  onImported,
}: {
  tools: AgentTool[]
  onClose(): void
  onImported(): void
}) {
  const [file, setFile] = useState<File | null>(null)
  const sources = useManagementResource(
    'skill-extension-sources',
    extensionsApi.list,
  )
  const [origin, setOrigin] = useState('zip')
  const choices = (sources.data?.items ?? [])
    .filter((source) => source.enabled)
    .flatMap((source) =>
      (source.skills ?? []).map((skill) => ({
        source,
        skill,
        key: `${source.id}:${skill.id}`,
      })),
    )
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async () => {
    if ((origin === 'zip' && !file) || busy) return
    setBusy(true)
    setError('')
    try {
      if (origin !== 'zip') {
        const choice = choices.find((item) => item.key === origin)
        if (!choice) throw new Error('请选择可用的扩展技能')
        await agentSkillsApi.importExtension(
          choice.source.id,
          choice.source.activeVersion,
          choice.skill.id,
          selected,
        )
        onImported()
        return
      }
      if (!file) return
      if (file.size > 12 * 1024 * 1024) throw new Error('技能包最多 12 MiB')
      const encoded = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onerror = () => reject(new Error('文件读取失败'))
        reader.onload = () => resolve(String(reader.result).split(',')[1]!)
        reader.readAsDataURL(file)
      })
      await agentSkillsApi.importPackage(encoded, selected)
      onImported()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '导入失败')
    } finally {
      setBusy(false)
    }
  }
  return (
    <ManagementDialog
      open
      title="导入技能包"
      description="ZIP 根目录包含 SKILL.md；参考资料放 references/，Office 模板放 templates/。脚本须另行安装并授权为工具。"
      busy={busy}
      error={error}
      onOpenChange={onClose}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={busy || (origin === 'zip' && !file)}
            onClick={() => void submit()}
          >
            {busy ? '正在解析…' : '导入技能'}
          </Button>
        </>
      }
    >
      <ResourceState
        loading={sources.loading}
        error={sources.error}
        onRetry={sources.reload}
      />
      <FieldLabel title="技能来源">
        <select
          className={selectClass}
          disabled={busy}
          value={origin}
          onChange={(event) => {
            setOrigin(event.target.value)
            const choice = choices.find(
              (item) => item.key === event.target.value,
            )
            setSelected(
              choice
                ? tools
                    .filter(
                      (tool) =>
                        tool.enabled &&
                        tool.implementation?.sourceId === choice.source.id &&
                        choice.skill.requiredToolIds.includes(
                          tool.implementation.toolId,
                        ),
                    )
                    .map((tool) => tool.id)
                : [],
            )
          }}
        >
          <option value="zip">上传技能 ZIP</option>
          {choices.map((choice) => (
            <option key={choice.key} value={choice.key}>
              {choice.source.name} · {choice.skill.name} ·{' '}
              {choice.source.activeVersion}
            </option>
          ))}
        </select>
      </FieldLabel>
      {origin === 'zip' && (
        <FieldLabel title="技能 ZIP">
          <Input
            type="file"
            accept=".zip"
            disabled={busy}
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </FieldLabel>
      )}
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm">选择技能依赖的已配置工具</legend>
        {tools
          .filter((tool) => tool.enabled)
          .map((tool) => (
            <label key={tool.id} className="flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={selected.includes(tool.id)}
                disabled={busy}
                onChange={(event) =>
                  setSelected(
                    event.target.checked
                      ? [...selected, tool.id]
                      : selected.filter((id) => id !== tool.id),
                  )
                }
              />
              {tool.name}
            </label>
          ))}
      </fieldset>
    </ManagementDialog>
  )
}
