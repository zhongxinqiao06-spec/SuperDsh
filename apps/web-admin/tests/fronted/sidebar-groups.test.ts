import { describe, expect, it } from 'vitest'
import {
  availableProjectName,
  findWorkspaceProject,
  sidebarGroups,
  workspacePathKey,
} from '@/utils/workbench/sidebar-groups'
import type {
  WorkspaceProject,
  WorkspaceSession,
} from '@/types/workbench/models'

const project = (id: string): WorkspaceProject => ({
  id,
  name: id,
  connectorId: 'desktop',
  workspacePath: `/${id}`,
  pinned: false,
  activeSessionCount: 0,
})
const session = (id: string, projectId: string | null): WorkspaceSession => ({
  id,
  projectId,
  connectorId: 'desktop',
  runtimeId: 'dsh',
  runtime: 'dsh',
  title: id,
  cwd: '/synthetic',
  status: 'idle',
  pinned: false,
  archived: false,
  takeover: true,
  unread: false,
  updatedSeq: 0,
  agentDefinition: null,
})

/** 期望来自旧 sidebar-selectors/project-visibility/project-list-order 的产品规则。 */
describe('侧栏分组与旧项目语义', () => {
  it('置顶单列，项目只含所属会话，缺设备读取权限仍识别服务端会话', () => {
    const sessions = [
      { ...session('pinned', 'first'), pinned: true },
      session('first-session', 'first'),
      session('second-session', 'second'),
      { ...session('server', null), executorKind: 'server-agent' as const },
      session('loose', 'missing'),
      { ...session('archived', 'first'), archived: true },
    ]
    const result = sidebarGroups(
      [],
      [project('first'), project('second')],
      sessions,
      false,
    )
    expect(result.pinned.map((item) => item.id)).toEqual(['pinned'])
    expect(
      result.projects
        .find((item) => item.project.id === 'first')
        ?.sessions.map((item) => item.id),
    ).toEqual(['first-session'])
    expect(result.server.map((item) => item.id)).toEqual(['server'])
    expect(result.unassigned.map((item) => item.id)).toEqual(['loose'])
    expect(
      sidebarGroups(
        [],
        [project('first')],
        sessions,
        true,
      ).projects[0]?.sessions.map((item) => item.id),
    ).toEqual(['archived'])
  })
  it('仅显式手建项目享受空项目例外，活动排序合并未加载历史的服务端聚合', () => {
    const projects = [
      project('implicit-empty'),
      { ...project('manual-empty'), manuallyCreated: true },
      { ...project('older'), lastActivityAt: '2026-11-01T00:00:00Z' },
      { ...project('recent'), lastActivityAt: '2026-11-03T00:00:00Z' },
    ]
    const sessions = [session('old', 'older'), session('new', 'recent')]
    expect(
      sidebarGroups([], projects, sessions, false).projects.map(
        (item) => item.project.id,
      ),
    ).toEqual(['manual-empty', 'recent', 'older'])
    expect(projects.map((item) => item.id)).toEqual([
      'implicit-empty',
      'manual-empty',
      'older',
      'recent',
    ])
  })
  it('同工作区只在同设备匹配，Windows忽略大小写，候选名排除自身并保持Unicode完整', () => {
    const existing = {
      ...project('bound'),
      workspacePath: 'C:\\Team\\',
      name: '团队',
    }
    expect(
      findWorkspaceProject([existing], 'desktop', 'c:/team/.', 'windows')?.id,
    ).toBe('bound')
    expect(
      findWorkspaceProject([existing], 'other-device', 'C:/Team', 'windows'),
    ).toBeUndefined()
    expect(workspacePathKey('/Team/../Docs')).toBe('/Docs')
    expect(workspacePathKey('/Team')).not.toBe(workspacePathKey('/team'))
    expect(availableProjectName('团队', [existing], 'bound')).toBe('团队')
    const name = '🙂'.repeat(255)
    const candidate = availableProjectName(name, [{ id: 'occupied', name }])
    expect(Array.from(candidate)).toHaveLength(255)
    expect(candidate.endsWith(' (1)')).toBe(true)
  })
})
