import type { StudioAsset, Job } from '@/types/studio/studio'

export const assetKinds: Record<StudioAsset['kind'], string> = {
  character: '角色',
  scene: '场景',
  prop: '道具',
  image: '图片',
  video: '视频',
  audio: '音频',
  music: '背景音乐',
}
export const jobKinds: Record<Job['kind'], string> = {
  image: '参考画面',
  video: '动态镜头',
  speech: '台词配音',
  export: '成片导出',
}
export const jobStates: Record<string, string> = {
  paused: '已停止本地处理，待核对',
  cancelled: '已取消',
  unaccepted: '人工核对未受理',
  queued: '等待提交',
  submitting: '正在提交',
  polling: '生成中',
  downloading: '正在下载',
  ready: '已完成',
  failed: '失败',
  unknown: '待核对',
}
export const mediaKind = (kind: StudioAsset['kind']) =>
  kind === 'video'
    ? 'video'
    : kind === 'audio' || kind === 'music'
      ? 'audio'
      : 'image'
