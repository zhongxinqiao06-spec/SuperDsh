import { describe, expect, it } from 'vitest'
import {
  replaceScript,
  updateScript,
} from '../../fronted/src/utils/studio/script-text'
import type { StudioDocument } from '../../fronted/src/types/studio/studio'

function document(): StudioDocument {
  return {
    script: '😀开头。甲乙。结束。',
    scenes: [
      {
        id: 'one',
        title: '第一场',
        synopsis: '',
        scriptRange: { start: 4, end: 7 },
      },
    ],
    assets: [],
    shots: [],
    music: null,
    musicVolume: 1,
  }
}
describe('正文和场次共享内容与 Unicode 范围', () => {
  it('本场修改同步全文，保留场次身份并更新范围', () => {
    const d = document()
    replaceScript(d, 4, 7, '甲乙丙丁。')
    expect(d.script).toBe('😀开头。甲乙丙丁。结束。')
    expect(d.scenes?.[0]?.scriptRange).toEqual({ start: 4, end: 9 })
  })
  it('前文粘贴后关联位置随 Unicode 字符移动', () => {
    const d = document()
    updateScript(d, '新增' + d.script)
    expect(d.scenes?.[0]?.scriptRange).toEqual({ start: 6, end: 9 })
  })
  it('跨边界整篇替换解除关联，不猜测新正文中的同名片段', () => {
    const d = document()
    updateScript(d, '另一份正文')
    expect(d.scenes?.[0]?.scriptRange).toBeNull()
  })
})
