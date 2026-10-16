import { useEffect, useState } from 'react'
import {
  platformAgentDefinitions,
  type PlatformAgentDefinition,
} from '@superdsh/core/client/platform'
import type { Request } from './platform-model.ts'

export function useAgentDefinitions(
  request: Request,
  device: string,
  sessionId: string,
  isServerAgent: boolean,
) {
  const scope = isServerAgent && device && !sessionId ? device : ''
  const [version, setVersion] = useState(0)
  const [state, setState] = useState<{
    scope: string
    request: Request
    items: PlatformAgentDefinition[]
    selectedId: string
    loading: boolean
    error: string
  }>({
    scope: '',
    request,
    items: [],
    selectedId: '',
    loading: false,
    error: '',
  })
  useEffect(() => {
    let disposed = false
    setState((previous) => ({
      scope,
      request,
      items:
        previous.scope === scope && previous.request === request
          ? previous.items
          : [],
      selectedId:
        previous.scope === scope && previous.request === request
          ? previous.selectedId
          : '',
      loading: !!scope,
      error: '',
    }))
    if (!scope) return
    void request({ operation: 'agents' }).then(
      (value) => {
        if (!disposed) {
          const items = platformAgentDefinitions(value)
          setState((previous) => ({
            scope,
            request,
            items,
            selectedId: previous.selectedId,
            loading: false,
            error:
              previous.selectedId &&
              !items.some((agent) => agent.id === previous.selectedId)
                ? '所选智能体已不可用，请重新选择'
                : '',
          }))
        }
      },
      (reason: unknown) => {
        if (!disposed)
          setState((previous) => ({
            scope,
            request,
            items: [],
            selectedId: previous.selectedId,
            loading: false,
            error: reason instanceof Error ? reason.message : String(reason),
          }))
      },
    )
    return () => {
      disposed = true
    }
  }, [scope, request, version])
  // Hide old account/target data synchronously, before effects dispose its request.
  const current =
    scope && state.scope === scope && state.request === request ? state : null
  return {
    visible: !!scope,
    items: current?.items ?? [],
    selectedId: current?.selectedId ?? '',
    loading: !!scope && (current?.loading ?? true),
    error: current?.error ?? '',
    select: (selectedId: string) =>
      setState((previous) => {
        if (!scope || previous.scope !== scope || previous.request !== request)
          return previous
        if (
          selectedId &&
          !previous.items.some((agent) => agent.id === selectedId)
        )
          return previous
        return { ...previous, selectedId }
      }),
    refresh: () => setVersion((value) => value + 1),
  }
}
