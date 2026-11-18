import type { Dialogue, Shot, StudioProject } from '@/types/studio/studio'

/** 台词可选生成结果或素材库版本；没有可靠时长时由播放器元数据补全。 */
export function dialogueDuration(
  project: StudioProject,
  line: Dialogue,
): number {
  if (line.audioAssetId)
    return (
      project.assets.find((asset) => asset.id === line.audioAssetId)
        ?.durationMs ?? 0
    )
  return project.jobs.find((job) => job.id === line.audio)?.duration ?? 0
}

/** 预演使用和正式渲染相同的源画面入出点。 */
export function shotPlaybackDuration(shot: Shot): number {
  return Math.max(0, (shot.trimEnd ?? shot.duration) - shot.trimStart)
}

export interface PreviewAudioTrack {
  id: string
  assetId?: string
  jobId?: string
  start: number
  sourceStart: number
  duration: number | null
  volume: number
  loop: boolean
}

/** 把配音、全片音乐和跨镜音效换算到当前镜头，保留裁剪前已经开始的声音。 */
export function previewAudioTracks(
  project: StudioProject,
  index: number,
): PreviewAudioTrack[] {
  const shot = project.document.shots[index]
  if (!shot) return []
  const offsets = new Map<string, number>()
  let cursor = 0
  for (const entry of project.document.shots) {
    offsets.set(entry.id, cursor - entry.trimStart)
    cursor += shotPlaybackDuration(entry)
  }
  const offset = (offsets.get(shot.id) ?? 0) + shot.trimStart
  const tracks: PreviewAudioTrack[] = shot.lines
    .filter((line) => line.audio || line.audioAssetId)
    .map((line) => ({
      id: line.id,
      ...(line.audioAssetId
        ? { assetId: line.audioAssetId }
        : { jobId: line.audio! }),
      start: line.start - shot.trimStart,
      sourceStart: 0,
      duration: dialogueDuration(project, line) || null,
      volume: line.volume,
      loop: false,
    }))
  for (const effect of project.document.soundEffects ?? []) {
    const fullDuration = project.assets.find(
      (asset) => asset.id === effect.assetId,
    )?.durationMs
    const sourceEnd = effect.trimEnd ?? fullDuration
    const start =
      effect.start +
      (effect.shotId ? (offsets.get(effect.shotId) ?? 0) : 0) -
      offset
    const duration =
      sourceEnd != null ? Math.max(0, sourceEnd - effect.trimStart) : null
    if (
      start >= shotPlaybackDuration(shot) ||
      (duration != null && start + duration <= 0)
    )
      continue
    tracks.push({
      id: 'effect:' + effect.id,
      assetId: effect.assetId,
      start,
      sourceStart: effect.trimStart,
      duration,
      volume: effect.volume,
      loop: false,
    })
  }
  if (project.document.music)
    tracks.push({
      id: 'background-music',
      assetId: project.document.music,
      start: -offset,
      sourceStart: 0,
      duration: null,
      volume: project.document.musicVolume,
      loop: true,
    })
  return tracks
}
