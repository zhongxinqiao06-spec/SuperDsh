import { describe, expect, it } from 'vitest'
import { sampleProgress } from '../../fronted/src/utils/studio/sample-progress'
import type { Job } from '../../fronted/src/types/studio/studio'
import { studioProposalFixture } from '../fixtures/studio-proposal'

const { shot } = studioProposalFixture()
function job(
  kind: Job['kind'],
  state: string,
  subject = kind === 'speech' ? shot.lines[0]!.id : shot.id,
): Job {
  return {
    id: kind + state + subject,
    kind,
    subject,
    state,
    revision: 1,
    error: null,
    duration: null,
  }
}
describe('试做进度与重复提交边界', () => {
  it('只汇总当前镜和所属台词，其他镜任务不阻挡试做', () => {
    const value = sampleProgress(shot, [
      job('video', 'queued', 'another-shot'),
      job('speech', 'polling', 'another-line'),
    ])
    expect(value.total).toBe(0)
    expect(value.active).toBe(false)
  })
  it('视频排队或配音处理中都阻止同镜重复试做', () => {
    const value = sampleProgress(shot, [
      job('video', 'queued'),
      job('speech', 'polling'),
    ])
    expect(value.active).toBe(true)
    expect(value.rows[0]!.summary).toBe('排队 1')
    expect(value.rows[1]!.summary).toBe('处理中 1')
  })
  it('失败可重新检查，未知受理须先核对，完成候选继续保留', () => {
    expect(sampleProgress(shot, [job('video', 'failed')])).toMatchObject({
      active: false,
      unresolved: false,
      failed: 1,
    })
    const value = sampleProgress(shot, [
      job('video', 'unknown'),
      job('speech', 'ready'),
    ])
    expect(value.unresolved).toBe(true)
    expect(value.rows[0]!.summary).toBe('待核对 1')
    expect(value.rows[1]!.summary).toBe('已完成 1')
    expect(sampleProgress(undefined, [job('video', 'queued')]).total).toBe(0)
  })
})
