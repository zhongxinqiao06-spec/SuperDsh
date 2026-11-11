import { describe, expect, it } from 'vitest'
import {
  canComposeSession,
  canControlSession,
} from '@/utils/workbench/session-access'
import type { WorkspaceSession } from '@/types/workbench/models'

/** 外部会话默认只读；接管控制与运行态发送限制必须分别校验。 */
describe('会话接管契约', () => {
  const session: WorkspaceSession = {
    id: 'synthetic',
    connectorId: 'synthetic',
    projectId: null,
    runtimeId: 'dsh',
    runtime: 'dsh',
    title: '合成会话',
    cwd: '',
    status: 'idle',
    pinned: false,
    archived: false,
    takeover: true,
    unread: false,
    updatedSeq: 0,
    agentDefinition: null,
  }
  it('未创建草稿可编辑，但没有已创建会话就不能中断或确认', () => {
    expect(canComposeSession(null)).toBe(true)
    expect(canControlSession(null)).toBe(false)
  })
  it('接管为真时可写，为假时所有控制入口均只读', () => {
    expect(canComposeSession(session)).toBe(true)
    expect(canControlSession(session)).toBe(true)
    expect(canComposeSession({ ...session, takeover: false })).toBe(false)
    expect(canControlSession({ ...session, takeover: false })).toBe(false)
  })
  it('运行中可中断但不能再发，归档后不能控制', () => {
    expect(canComposeSession({ ...session, status: 'running' })).toBe(false)
    expect(canControlSession({ ...session, status: 'running' })).toBe(true)
    expect(canControlSession({ ...session, archived: true })).toBe(false)
    expect(canComposeSession({ ...session, archived: true })).toBe(false)
  })
})
