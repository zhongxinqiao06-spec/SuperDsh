import { ElMessageBox } from 'element-plus'
import { libraryApi } from '@/api/studio/library-api'
import type { StudioAsset, StudioDocument } from '@/types/studio/studio'
import type { AssetUseTarget } from '@/utils/studio/asset-use'

/** 采用前核对真实媒体长度；短视频需要明确确认，绝不静默截断台词或覆盖工程。 */
export async function prepareAssetUse(
  source: StudioAsset,
  target: AssetUseTarget,
  document: StudioDocument,
) {
  let asset = source
  if (['video', 'audio', 'music'].includes(source.kind) && !source.durationMs) {
    const metadata = await libraryApi.metadata(source.id, source.project)
    asset = { ...source, durationMs: metadata.durationMs }
  }
  if (target.kind === 'video') {
    const shotId = target.shotId
    const shot = document.shots.find((item) => item.id === shotId)
    if (!shot) throw new Error('目标镜头已变化，请重新选择')
    if (asset.durationMs && asset.durationMs < shot.duration) {
      await ElMessageBox.confirm(
        `所选视频只有 ${(asset.durationMs / 1000).toFixed(1)} 秒，当前镜头目标为 ${(shot.duration / 1000).toFixed(1)} 秒。采用后将缩短本镜，原台词与配音保留，请在时间线检查是否超出。`,
        '视频短于镜头目标',
        {
          confirmButtonText: '缩短本镜并采用',
          cancelButtonText: '重新选择',
          type: 'warning',
        },
      ).catch(() => {
        throw new Error('已取消采用，请选择其他素材或调整镜头时长')
      })
      target = { ...target, confirmedDuration: asset.durationMs }
    }
  }
  return { asset, target }
}
