import { useEffect, useRef, useState } from 'react'
import {
  platformAgentDefinitions,
  type PlatformAgentDefinition,
} from '@superdsh/core/client/platform'
import { PlatformSelect } from './PlatformSelect.tsx'
import { object, string } from './platform-model.ts'
import type { PlatformWorkspaceModel } from './use-platform-workspace.ts'

export function SessionAgentSelect({
  model,
}: {
  model: PlatformWorkspaceModel
}) {
  const { sessionId, request } = model
  const [state, setState] = useState<{
    items: PlatformAgentDefinition[]
    id: string
    version: number
    error: string
    ready: boolean
  }>({ items: [], id: '', version: 0, error: '', ready: false })
  const [revision, setRevision] = useState(0)
  const generation = useRef(0)
  useEffect(() => {
    const current = ++generation.current
    setState({ items: [], id: '', version: 0, error: '', ready: false })
    void Promise.all([
      request({ operation: 'agents' }),
      request({ operation: 'agent-binding', sessionId }),
    ]).then(
      ([catalog, binding]) => {
        if (current === generation.current)
          setState({
            items: platformAgentDefinitions(catalog),
            id: string(object(object(binding).agentDefinition).id),
            version: Number(object(binding).bindingVersion),
            error: '',
            ready: true,
          })
      },
      (error) => {
        if (current === generation.current)
          setState((previous) => ({ ...previous, error: String(error) }))
      },
    )
    return () => {
      generation.current++
    }
  }, [sessionId, request, revision])
  return (
    <div className="productAgentSelection">
      <PlatformSelect
        label="本会话智能体"
        value={state.id}
        disabled={
          model.busy ||
          !model.online ||
          !state.ready ||
          !model.allows('session.send_message')
        }
        onChange={(id) => {
          if (!id) return
          const current = generation.current
          void model.run(async () => {
            await request({
              operation: 'set-agent-binding',
              sessionId,
              body: { agentDefinitionId: id, bindingVersion: state.version },
            })
            if (current !== generation.current) return
            setRevision((value) => value + 1)
            await model.refreshSession()
          })
        }}
        options={[
          { value: '', label: state.ready ? '选择已发布智能体' : '正在读取…' },
          ...state.items.map((item) => ({
            value: item.id,
            label: item.name,
            detail: `v${item.version} · ${item.description}`,
          })),
        ]}
      />
      <small>
        切换只影响后续任务，旧方案与成果保留原配置；运行中请先等待或取消。
      </small>
      {state.error && (
        <p role="alert" className="platformError">
          {state.error}
        </p>
      )}
    </div>
  )
}
