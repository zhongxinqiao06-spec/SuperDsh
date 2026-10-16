import { useEffect, useState } from 'react'
import { platformAgentBinding } from '@superdsh/core/client/platform'
import {
  object,
  rows,
  string,
  type Request,
  type Row,
} from './platform-model.ts'

export function useAgentArtifacts(
  request: Request,
  device: string,
  sessionId: string,
  isServerAgent: boolean,
  runtimeStatus: string,
) {
  const scope =
    isServerAgent && sessionId ? JSON.stringify([device, sessionId]) : ''
  const [version, setVersion] = useState(0)
  const [state, setState] = useState<{
    scope: string
    request: Request
    value: Row
    error: string
    loading: boolean
  }>({ scope: '', request, value: {}, error: '', loading: false })
  useEffect(() => {
    if (!scope) return
    let disposed = false
    setState((previous) => ({
      scope,
      request,
      value:
        previous.scope === scope && previous.request === request
          ? previous.value
          : {},
      error: '',
      loading: true,
    }))
    void request({ operation: 'agent-artifacts', sessionId }).then(
      (value) => {
        if (!disposed)
          setState({
            scope,
            request,
            value: object(value),
            error: '',
            loading: false,
          })
      },
      (reason: unknown) => {
        if (!disposed)
          setState((previous) => ({
            ...previous,
            error: reason instanceof Error ? reason.message : String(reason),
            loading: false,
          }))
      },
    )
    return () => {
      disposed = true
    }
  }, [scope, request, sessionId, runtimeStatus, version])
  const current =
    scope && state.scope === scope && state.request === request ? state : null
  return {
    items: rows(current?.value.items).filter((file) => !!string(file.fileId)),
    binding: platformAgentBinding(current?.value.agentDefinition),
    loading: !!scope && (current?.loading ?? true),
    error: current?.error ?? '',
    refresh: () => setVersion((value) => value + 1),
  }
}
