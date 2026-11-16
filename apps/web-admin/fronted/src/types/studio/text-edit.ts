/** 选段与单场共用局部编辑契约，范围使用 Unicode 字符而非 UTF-16 下标。 */
export interface TextEditTarget {
  scope: 'selection' | 'scene'
  sceneId?: string
  label: string
  start: number
  end: number
  text: string
  script: string
}
export interface TextEdit {
  id: string
  scope: 'selection' | 'scene'
  label: string
  original: string
  suggestion: string | null
  instruction: string
  state: 'waiting' | 'ready' | 'applied' | 'discarded' | 'undone'
  revision: number
  conflict: string | null
  prompt?: string
  sessionId?: string | null
}
