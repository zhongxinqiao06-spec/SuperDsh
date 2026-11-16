import type { StudioProject, Shot } from '../../fronted/src/types/studio/studio'
import type { ProposalComparison } from '../../fronted/src/types/studio/preparation'

/** 合成导演建议，稳定身份刻意采用 UUID 验证用户界面不会泄露技术标识。 */
export function studioProposalFixture() {
  const sceneId = '10000000-0000-4000-8000-000000000001'
  const roleId = '20000000-0000-4000-8000-000000000001'
  const shot: Shot = {
    id: '30000000-0000-4000-8000-000000000001',
    sceneId,
    action: '主角在海边捡起椰子，望向远处的灯塔。',
    scene: '晴天海滩',
    camera: '中景',
    framing: '',
    movement: '缓慢推进',
    duration: 5000,
    references: [roleId],
    candidate: null,
    trimStart: 0,
    trimEnd: null,
    lines: [
      {
        id: '40000000-0000-4000-8000-000000000001',
        role: roleId,
        text: '一起去看看吧！',
        voice: '',
        subtitle: null,
        start: 0,
        end: null,
        audio: null,
        volume: 1,
      },
    ],
  }
  const script =
    '主角来到海边，看到椰子和远处的灯塔。\n' +
    '海风吹过，主角和朋友一起沿海岸散步。'.repeat(30)
  const project: StudioProject = {
    id: 'proposal-fixture',
    title: '海岛小旅行',
    revision: 3,
    sessionId: null,
    updated: '',
    assets: [
      {
        id: roleId,
        name: '小鹿',
        kind: 'character',
        description: '合成形象',
        family: 'role',
        parent: null,
        project: 'proposal-fixture',
        voice: '',
        fileId: null,
      },
    ],
    jobs: [],
    history: [],
    proposal: { id: 'proposal', revision: 2, shots: [shot] },
    document: {
      script: '手工保留的开头',
      scenes: [],
      adaptationMode: 'adapt',
      shots: [],
      assets: [roleId],
      music: null,
      musicVolume: 1,
    },
  }
  const comparison: ProposalComparison = {
    id: 'proposal',
    baseRevision: 2,
    revision: 3,
    state: 'pending',
    changes: [
      {
        key: 'script',
        label: '剧本正文',
        before: '',
        current: project.document.script,
        after: script,
        conflict: true,
      },
      {
        key: 'scenes',
        label: '场次安排',
        before: [],
        current: [],
        after: [
          {
            id: sceneId,
            title: '海滩 · 清晨',
            synopsis: '主角第一次看见大海',
            scriptRange: { start: 0, end: 20 },
          },
        ],
        conflict: false,
      },
      {
        key: 'shot:' + shot.id,
        label: '镜 1 · 新增',
        before: null,
        current: null,
        after: shot,
        conflict: false,
      },
      {
        key: 'shots:order',
        label: '镜头顺序',
        before: [],
        current: [],
        after: [shot.id],
        conflict: false,
      },
    ],
  }
  return { project, comparison, shot, roleId, sceneId }
}
