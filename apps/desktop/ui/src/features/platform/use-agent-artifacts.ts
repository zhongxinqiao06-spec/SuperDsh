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
    void Promise.all([
      request({ operation: 'agent-artifacts', sessionId }),
      request({ operation: 'office-plans', sessionId }),
      request({ operation: 'agent-evidence', sessionId }),
      request({ operation: 'skill-runs', sessionId }),
    ]).then(
      ([value, plans, evidence, skillRuns]) => {
        if (!disposed)
          setState({
            scope,
            request,
            value: {
              ...object(value),
              plans: object(plans).items ?? [],
              evidence: object(evidence).items ?? [],
              skillRuns: object(skillRuns).items ?? [],
              answerVerification: object(evidence).answerVerification ?? {},
            },
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
  useEffect(() => {
    if (!scope) return
    const timer = setInterval(() => setVersion((value) => value + 1), 5000)
    return () => clearInterval(timer)
  }, [scope])
  const current =
    scope && state.scope === scope && state.request === request ? state : null
  return {
    items: rows(current?.value.items).filter((file) => !!string(file.fileId)),
    plans: rows(current?.value.plans),
    skillRuns: rows(current?.value.skillRuns),
    evidence: rows(current?.value.evidence),
    answerVerification: object(current?.value.answerVerification),
    binding: platformAgentBinding(current?.value.agentDefinition),
    loading: !!scope && (current?.loading ?? true),
    error: current?.error ?? '',
    refresh: () => setVersion((value) => value + 1),
  }
}
