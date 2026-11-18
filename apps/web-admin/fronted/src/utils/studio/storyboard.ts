import { createUuid } from '@/utils/uuid'
import type {
  Dialogue,
  Job,
  Shot,
  StudioDocument,
  StudioAsset,
} from '@/types/studio/studio'
/** 文本截断与音频冲突都按实际采用配音和剪辑出点计算，未生成的音频时长未知。 */
export function voiceConflict(
  line: Dialogue,
  shot: Shot,
  durations: ReadonlyMap<string, number>,
) {
  const source = line.audioAssetId || line.audio
  if (!source) return false
  const duration = durations.get(source)
  return (
    duration != null && line.start + duration > (shot.trimEnd ?? shot.duration)
  )
}
export function voiceDurations(jobs: Job[], assets: StudioAsset[] = []) {
  return new Map([
    ...jobs
      .filter((j) => j.kind === 'speech' && j.duration != null)
      .map((j) => [j.id, j.duration!] as [string, number]),
    ...assets
      .filter(
        (asset) =>
          asset.durationMs != null && ['audio', 'music'].includes(asset.kind),
      )
      .map((asset) => [asset.id, asset.durationMs!] as [string, number]),
  ])
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
/** 复制镜头时为音效创建独立身份；同一库媒体可以复用，后续移除互不影响。 */
export function duplicateShot(
  document: StudioDocument,
  shotId: string,
): Shot | undefined {
  const index = document.shots.findIndex((shot) => shot.id === shotId)
  const source = document.shots[index]
  if (!source) return
  const copy = copyShot(source)
  const effects = (document.soundEffects ?? [])
    .filter((effect) => effect.shotId === source.id)
    .map((effect) => ({ ...effect, id: newId(), shotId: copy.id }))
  document.shots.splice(index + 1, 0, copy)
  if (effects.length)
    document.soundEffects = [...(document.soundEffects ?? []), ...effects]
  return copy
}

/**
 * 等分库视频的可见源区间，两半保留绝对源时基；生成候选沿用原有分镜拆分。
 * 库配音跨界时仅复用来源、分配新台词身份，后半通过镜头入点裁掉已播放部分。
 * 生成配音无法跨台词复用任务，跨界或时长未知时拒绝并保留全部原稿。
 */
export function splitShot(
  document: StudioDocument,
  shotId: string,
  durations: ReadonlyMap<string, number> = new Map(),
): Shot | undefined {
  const index = document.shots.findIndex((shot) => shot.id === shotId)
  const source = document.shots[index]
  if (!source) return
  const end = source.videoAssetId
    ? (source.trimEnd ?? source.duration)
    : source.duration
  const start = source.videoAssetId ? source.trimStart : 0
  if (end - start < 2000) return
  const middle = start + Math.floor((end - start) / 2)
  if (
    source.videoAssetId &&
    source.lines.some((line) => {
      if (!line.audio || line.start >= middle) return false
      const duration = durations.get(line.audio)
      return duration == null || line.start + duration > middle
    })
  )
    throw new Error(
      '分割点经过已生成的配音，或配音时长未知；请先调整配音位置，再等分镜头。',
    )
  const copy = copyShot(source)
  if (source.videoAssetId) {
    // 两个片段的源坐标不平移，FFmpeg 用 trimStart 同时裁剪画面和库配音。
    copy.trimStart = middle
    copy.trimEnd = source.trimEnd
    copy.lines = source.lines.flatMap((line) => {
      if (line.start >= middle) return [{ ...line }]
      const duration = line.audioAssetId ? durations.get(line.audioAssetId) : 0
      if (
        !line.audioAssetId ||
        (duration != null && line.start + duration <= middle)
      )
        return []
      return [{ ...line, id: newId() }]
    })
    source.lines = source.lines.filter((line) => line.start < middle)
    source.trimEnd = middle
  } else {
    copy.duration = source.duration - middle
    copy.lines = source.lines
      .filter((line) => line.start >= middle)
      .map((line) => ({
        ...line,
        start: line.start - middle,
        subtitleStart:
          line.subtitleStart == null
            ? null
            : Math.max(0, line.subtitleStart - middle),
        end: line.end === null ? null : Math.max(1, line.end - middle),
      }))
    source.lines = source.lines.filter((line) => line.start < middle)
    source.duration = middle
    source.trimStart = 0
    source.trimEnd = null
    copy.trimStart = 0
    copy.trimEnd = null
  }
  // 跨界音效只保留一次，由整片混音自然续播；后半开始的音效跟随后半镜头移动。
  for (const effect of document.soundEffects ?? []) {
    if (effect.shotId !== source.id || effect.start < middle) continue
    effect.shotId = copy.id
    if (!source.videoAssetId) effect.start -= middle
  }
  document.shots.splice(index + 1, 0, copy)
  return copy
}

/** 删除镜头和它拥有的音效，保留其他镜头及全片时间锚定的音效。 */
export function removeShot(document: StudioDocument, shotId: string): void {
  document.shots = document.shots.filter((shot) => shot.id !== shotId)
  if (document.soundEffects)
    document.soundEffects = document.soundEffects.filter(
      (effect) => effect.shotId !== shotId,
    )
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
