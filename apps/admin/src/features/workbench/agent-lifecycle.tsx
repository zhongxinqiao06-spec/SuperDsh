'use client'

import { useEffect } from 'react'
import { useAuth } from '@/components/auth/auth-context'
import { serverAgentApi } from '@/features/dashboard/server-agent'
import { workbenchCell } from './memory'

export type Preparation = {
  attempted: boolean
  pending: Promise<unknown> | null
  error: string
}

export const INITIAL_PREPARATION: Preparation = {
  attempted: false,
  pending: null,
  error: '',
}

/** Keep a single preparation attempt per login, without a background poller. */
export function prepareWorkbenchAgent(force = false): Promise<unknown> {
  const cell = workbenchCell<Preparation>(
    'agent-preparation',
    INITIAL_PREPARATION,
  )
  if (cell.get().pending) return cell.get().pending!
  if (cell.get().attempted && !force) return Promise.resolve()
  const request = serverAgentApi
    .get()
    .then(({ agent }) => {
      if (!cell.current()) return
      if (agent.status === 'running' || agent.status === 'starting') return
      if (!force && (agent.status !== 'stopped' || agent.error)) return
      return serverAgentApi.prepare()
    })
    .catch((cause: unknown) => {
      cell.set((current) => ({
        ...current,
        error: cause instanceof Error ? cause.message : String(cause),
      }))
      throw cause
    })
    .finally(() => {
      cell.set((current) => ({ ...current, attempted: true, pending: null }))
    })
  cell.set({ attempted: true, pending: request, error: '' })
  return request
}

export function WorkbenchAgentLifecycle() {
  const { session, can } = useAuth()
  const allowed =
    can('devices.manage') && can('sessions.run') && can('models.use')
  useEffect(() => {
    if (!session || !allowed) return
    void prepareWorkbenchAgent().catch(() => undefined)
  }, [session?.userId, session?.authzVersion, allowed])
  return null
}
