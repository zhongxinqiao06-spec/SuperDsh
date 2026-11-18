import type { StudioAsset, StudioDocument } from '@/types/studio/studio'

/** 素材用途决定真实工程引用，选用不会借用其他作品的任务 ID。 */
export type AssetUseTarget =
  | { kind: 'library' }
  | { kind: 'scene'; sceneId: string }
  | { kind: 'shot-scene'; shotId: string }
  | { kind: 'reference'; shotId: string }
  | { kind: 'video'; shotId: string; confirmedDuration?: number }
  | { kind: 'audio'; shotId: string; lineId: string }
  | { kind: 'music' }
  | { kind: 'effect'; shotId: string; id: string }

export function applyAssetUse(
  document: StudioDocument,
  asset: StudioAsset,
  target: AssetUseTarget,
): void {
  if (target.kind === 'scene') {
    const scene = document.scenes?.find((item) => item.id === target.sceneId)
    if (!scene || asset.kind !== 'scene')
      throw new Error('场次或场景已变化，请重新选择')
    scene.sceneAssetId = asset.id
  } else if (target.kind === 'music') {
    if (!['music', 'audio'].includes(asset.kind))
      throw new Error('请选择音频或音乐素材')
    document.music = asset.id
  } else if (target.kind !== 'library') {
    const shot = document.shots.find((item) => item.id === target.shotId)
    if (!shot) throw new Error('镜头已变化，请重新选择')
    if (target.kind === 'shot-scene') {
      if (asset.kind !== 'scene') throw new Error('请选择场景素材')
      shot.sceneAssetId = asset.id
    } else if (target.kind === 'video') {
      if (asset.kind !== 'video') throw new Error('请选择视频素材')
      shot.videoAssetId = asset.id
      shot.candidate = null
      // 更换画面后重置旧视频的裁剪点，避免沿用超出新媒体长度的区间。
      shot.trimStart = 0
      shot.trimEnd = null
      if (target.confirmedDuration !== undefined)
        shot.duration = target.confirmedDuration
    } else if (target.kind === 'audio') {
      const line = shot.lines.find((item) => item.id === target.lineId)
      if (!line || !['audio', 'music'].includes(asset.kind))
        throw new Error('台词或音频已变化，请重新选择')
      line.audioAssetId = asset.id
      line.audio = null
    } else if (target.kind === 'effect') {
      if (!['audio', 'music'].includes(asset.kind))
        throw new Error('请选择音效文件')
      document.soundEffects ??= []
      const existing = document.soundEffects.find(
        (effect) => effect.id === target.id,
      )
      // 保存失败后重试沿用同次选择的稳定 ID，不重复插入音轨或重置手工排时。
      if (existing) {
        existing.assetId = asset.id
        existing.shotId = shot.id
      } else {
        document.soundEffects.push({
          id: target.id,
          assetId: asset.id,
          shotId: shot.id,
          start: 0,
          volume: 1,
          trimStart: 0,
          trimEnd: null,
        })
      }
    } else if (!shot.references.includes(asset.id))
      shot.references.push(asset.id)
  }
  if (!document.assets.includes(asset.id)) document.assets.push(asset.id)
}
