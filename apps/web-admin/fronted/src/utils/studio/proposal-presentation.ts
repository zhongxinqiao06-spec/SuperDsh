import type { ProposalChange } from '@/types/studio/preparation'
import type { StudioProject } from '@/types/studio/studio'

type Side = 'before' | 'current' | 'after'
type Fields = Record<string, unknown>
const fields = (value: unknown): Fields =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Fields)
    : {}
const rows = (value: unknown): Fields[] =>
  Array.isArray(value) ? value.map(fields) : []
const opaque = (value: string) =>
  /^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(value) ||
  /^(?:call|job|asset|scene|shot|line)_[a-z0-9_-]{16,}$/i.test(value)
const present = (value: unknown) =>
  value !== null &&
  value !== undefined &&
  value !== '' &&
  (!Array.isArray(value) || value.length > 0)
const excerpt = (text: string, length = 80) =>
  Array.from(text).slice(0, length).join('') +
  (Array.from(text).length > length ? '…' : '')
const seconds = (value: number) => `${Number((value / 1000).toFixed(3))} 秒`
const labels: Record<string, string> = {
  action: '动作',
  scene: '场景',
  sceneId: '所属场次',
  camera: '景别',
  framing: '构图',
  movement: '运镜',
  duration: '时长',
  references: '参考素材',
  lines: '对白',
  role: '角色',
  text: '台词',
  voice: '音色',
  subtitle: '字幕',
  subtitleStart: '字幕起点',
  start: '配音起点',
  end: '配音终点',
  volume: '音量',
  title: '场次名称',
  synopsis: '内容摘要',
  candidate: '采用画面',
  audio: '采用配音',
  trimStart: '裁剪起点',
  trimEnd: '裁剪终点',
}

/** 三方对比只转换展示：稳定身份和原始字段值始终保留在原 change 中用于精确采用。 */
export function proposalPresenter(
  project: StudioProject,
  changes: ProposalChange[],
) {
  const assets = new Map(project.assets.map((asset) => [asset.id, asset.name]))
  const contexts = Object.fromEntries(
    (['before', 'current', 'after'] as const).map((side) => {
      const sceneChange = changes.find((change) => change.key === 'scenes')
      const scenes = sceneChange
        ? rows(sceneChange[side])
        : rows(project.document.scenes)
      const scriptChange = changes.find((change) => change.key === 'script')
      const script = scriptChange
        ? String(scriptChange[side] ?? '')
        : project.document.script
      const shots = new Map<string, Fields>(
        (side === 'after'
          ? (project.proposal?.shots ?? project.document.shots)
          : project.document.shots
        ).map((shot) => [shot.id, { ...shot }]),
      )
      for (const change of changes) {
        const [kind, id, field] = change.key.split(':')
        if (kind !== 'shot' || !id) continue
        if (!field) {
          if (change[side]) shots.set(id, fields(change[side]))
          else shots.delete(id)
        } else if (shots.has(id))
          shots.set(id, { ...shots.get(id), [field]: change[side] })
      }
      const order = changes.find((change) => change.key === 'shots:order')?.[
        side
      ]
      const ids = Array.isArray(order) ? order.map(String) : [...shots.keys()]
      const lines = new Map<string, Fields>()
      for (const shot of shots.values())
        for (const line of rows(shot.lines)) lines.set(String(line.id), line)
      for (const change of changes) {
        const [kind, id, field] = change.key.split(':')
        if (kind !== 'line' || !id) continue
        if (!field && change[side]) lines.set(id, fields(change[side]))
        else if (field && lines.has(id))
          lines.set(id, { ...lines.get(id), [field]: change[side] })
      }
      return [side, { scenes, script, shots, ids, lines }]
    }),
  ) as Record<
    Side,
    {
      scenes: Fields[]
      script: string
      shots: Map<string, Fields>
      ids: string[]
      lines: Map<string, Fields>
    }
  >

  function name(value: unknown, fallback: string): string {
    if (typeof value !== 'string' || !value) return fallback
    return assets.get(value) ?? (opaque(value) ? fallback : value)
  }
  function scene(value: unknown, side: Side): string {
    const index = contexts[side].scenes.findIndex((item) => item.id === value)
    if (index < 0) return '场次待同步'
    const title = String(contexts[side].scenes[index]?.title ?? '')
    return `第 ${index + 1} 场${title ? ' · ' + title : ''}`
  }
  function dialogue(line: Fields): string {
    const text = String(line.text ?? '')
    const parts = [`${name(line.role, '角色待指定')}：${text || '台词待补充'}`]
    if (present(line.voice))
      parts.push('音色：' + name(line.voice, '已指定音色'))
    if (present(line.subtitle) && line.subtitle !== line.text)
      parts.push('字幕：' + String(line.subtitle))
    if (
      typeof line.start === 'number' &&
      (line.start > 0 || typeof line.end === 'number')
    )
      parts.push(
        `配音位置：${seconds(line.start)}${typeof line.end === 'number' ? ' 至 ' + seconds(line.end) : '起'}`,
      )
    if (typeof line.subtitleStart === 'number' && line.subtitleStart > 0)
      parts.push('字幕起点：' + seconds(line.subtitleStart))
    if (typeof line.volume === 'number' && line.volume !== 1)
      parts.push(`音量：${Math.round(line.volume * 100)}%`)
    if (present(line.audio)) parts.push('已有采用配音')
    return parts.join('\n')
  }
  function scalar(value: unknown, field: string, side: Side): string {
    if (!present(value)) return '未设置'
    if (fields(value).missing === true) return '此内容已移除'
    if (typeof value === 'number') {
      if (
        [
          'duration',
          'start',
          'end',
          'subtitleStart',
          'trimStart',
          'trimEnd',
        ].includes(field)
      )
        return seconds(value)
      if (field === 'volume') return `${Math.round(value * 100)}%`
      return String(value)
    }
    if (field === 'sceneId') return scene(value, side)
    if (field === 'role') return name(value, '角色待同步')
    if (field === 'references')
      return Array.isArray(value)
        ? value.map((id) => name(id, '素材待同步')).join('、')
        : name(value, '素材待同步')
    if (field === 'candidate') return '已采用镜头画面'
    if (field === 'audio') return '已采用配音'
    if (field === 'lines')
      return rows(value)
        .map((line) => dialogue(line))
        .join('\n\n')
    if (typeof value === 'string') return name(value, '引用内容待同步')
    if (Array.isArray(value))
      return value.map((item) => scalar(item, field, side)).join('\n')
    return (
      Object.entries(fields(value))
        .filter(([key, content]) => labels[key] && present(content))
        .map(
          ([key, content]) => `${labels[key]}：${scalar(content, key, side)}`,
        )
        .join('\n') || '未设置'
    )
  }
  function display(change: ProposalChange, side: Side): string {
    const value = change[side]
    if (!present(value)) return '暂无内容'
    if (change.key === 'script') return String(value)
    if (change.key === 'scenes')
      return (
        rows(value)
          .map((item, index) => {
            const parts = [`第 ${index + 1} 场 · ${item.title || '未命名场次'}`]
            if (present(item.synopsis)) parts.push(String(item.synopsis))
            const range = fields(item.scriptRange)
            if (
              typeof range.start === 'number' &&
              typeof range.end === 'number' &&
              contexts[side].script
            ) {
              const text = Array.from(contexts[side].script)
                .slice(range.start, range.end)
                .join('')
              if (text) parts.push('关联原稿：' + excerpt(text, 120))
            }
            return parts.join('\n')
          })
          .join('\n\n') || '暂无场次'
      )
    if (change.key === 'shots:order' && Array.isArray(value))
      return value
        .map((id, index) => {
          const shot = contexts[side].shots.get(String(id))
          return `第 ${index + 1} 镜 · ${shot?.action ? excerpt(String(shot.action), 60) : '镜头内容待同步'}`
        })
        .join('\n')
    const [kind, , field] = change.key.split(':')
    if (kind === 'lines' && field === 'order' && Array.isArray(value))
      return value
        .map((id, index) => {
          const line = contexts[side].lines.get(String(id))
          return `第 ${index + 1} 句 · ${line ? name(line.role, '角色待指定') + '：' + excerpt(String(line.text ?? ''), 60) : '台词待同步'}`
        })
        .join('\n')
    if (kind === 'line' && !field) return dialogue(fields(value))
    if (kind === 'shot' && !field)
      return (
        Object.entries(fields(value))
          .filter(
            ([key, content]) =>
              labels[key] &&
              present(content) &&
              !(
                ['trimStart', 'trimEnd', 'candidate'].includes(key) && !content
              ),
          )
          .map(
            ([key, content]) => `${labels[key]}：${scalar(content, key, side)}`,
          )
          .join('\n') || '暂无镜头内容'
      )
    return scalar(value, field ?? '', side)
  }
  return { display }
}
