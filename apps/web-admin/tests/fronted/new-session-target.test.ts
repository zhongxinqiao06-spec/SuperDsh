import { describe, expect, it } from 'vitest'
import { newSessionTarget } from '@/utils/workbench/new-session-target'

/** 设备、受管项目和普通项目的绑定不依赖目录读取权限。 */
describe('新会话项目绑定', () => {
  const managed = { connectorId: 'native', projectId: 'managed' }
  const projects = [
    {
      id: 'remote-project',
      connectorId: 'remote',
      name: '项目',
      workspacePath: '/team',
      pinned: false,
      activeSessionCount: 0,
    },
  ]
  it('仅有执行权限时使用 prepare 中的受管项目，不伪造路径', () => {
    expect(newSessionTarget('native', '', [], managed)).toEqual({
      connectorId: 'native',
      projectId: 'managed',
    })
  })
  it('跨设备、无项目和失效项目不能发送', () => {
    expect(newSessionTarget('remote', 'managed', projects, managed)).toBeNull()
    expect(newSessionTarget('remote', '', projects, managed)).toBeNull()
    expect(newSessionTarget('native', 'removed', projects, managed)).toBeNull()
  })
  it('普通项目提交其固定工作目录，不能任意拼接 cwd', () => {
    expect(
      newSessionTarget('remote', 'remote-project', projects, managed),
    ).toEqual({
      connectorId: 'remote',
      projectId: 'remote-project',
      cwd: '/team',
    })
  })
})
