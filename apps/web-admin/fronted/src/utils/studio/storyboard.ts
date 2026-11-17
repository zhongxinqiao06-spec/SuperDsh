import { createUuid } from '@/utils/uuid'
import type { Dialogue, Job, Shot, StudioDocument } from '@/types/studio/studio'
/** 文本截断与音频冲突都按实际采用配音和剪辑出点计算，未生成的音频时长未知。 */
export function voiceConflict(
  line: Dialogue,
  shot: Shot,
  durations: ReadonlyMap<string, number>,
) {
  if (!line.audio) return false
  const duration = durations.get(line.audio)
  return (
    duration != null && line.start + duration > (shot.trimEnd ?? shot.duration)
  )
}
export function voiceDurations(jobs: Job[]) {
  return new Map(
    jobs
      .filter((j) => j.kind === 'speech' && j.duration != null)
      .map((j) => [j.id, j.duration!]),
  )
}
export const newId = () => createUuid()
export function newShot(): Shot {
  return {
    id: newId(),
    action: '',
    scene: '',
    camera: '',
    framing: '',
    movement: '',
    duration: 5000,
    references: [],
    lines: [],
    candidate: null,
    trimStart: 0,
    trimEnd: null,
  }
}
/** 复制分镜会分配新的台词标识；旧镜候选仍保留在原镜头。 */
export function copyShot(shot: Shot): Shot {
  return {
    ...(JSON.parse(JSON.stringify(shot)) as Shot),
    id: newId(),
    candidate: null,
    lines: shot.lines.map((line) => ({ ...line, id: newId(), audio: null })),
  }
}
export function moveShot(document: StudioDocument, from: number, to: number) {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= document.shots.length ||
    to >= document.shots.length
  )
    return
  document.shots.splice(to, 0, ...document.shots.splice(from, 1))
}
