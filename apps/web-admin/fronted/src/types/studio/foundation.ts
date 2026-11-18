/** 制作规格与创建意图。历史作品允许缺少规格，由用户补充。 */
export interface ProjectBrief {
  title: string
  brief: string
  aspectWidth: number | null
  aspectHeight: number | null
  targetDurationMs: number | null
  language: string | null
  styleBrief: string
}
export interface CreationDefaults {
  aspectWidth: number
  aspectHeight: number
  targetDurationMs: number
  language: string
}
export interface StoryScene {
  /** 场次选用的环境版本，镜头可以单独覆盖。 */
  sceneAssetId?: string | null
  id: string
  title: string
  synopsis: string
  scriptRange?: { start: number; end: number } | null
}
