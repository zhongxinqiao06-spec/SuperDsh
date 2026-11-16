import type { Job, Shot } from '@/types/studio/studio'

/** 仅汇总当前镜头及其对白的任务；存在执行中或受理未决记录时不开放重复试做。 */
export function sampleProgress(shot: Shot | undefined, jobs: Job[]) {
  const lines = new Set(shot?.lines.map((line) => line.id) ?? [])
  const relevant = shot
    ? jobs.filter(
        (job) =>
          (job.kind === 'video' && job.subject === shot.id) ||
          (job.kind === 'speech' && lines.has(job.subject)),
      )
    : []
  const activeStates = ['queued', 'submitting', 'polling', 'downloading']
  const unresolvedStates = ['unknown', 'paused']
  const rows = (['video', 'speech'] as const).map((kind) => {
    const records = relevant.filter((job) => job.kind === kind)
    const counters = [
      ['排队', records.filter((job) => job.state === 'queued').length],
      [
        '处理中',
        records.filter(
          (job) => activeStates.includes(job.state) && job.state !== 'queued',
        ).length,
      ],
      ['失败', records.filter((job) => job.state === 'failed').length],
      [
        '待核对',
        records.filter((job) => unresolvedStates.includes(job.state)).length,
      ],
      ['已完成', records.filter((job) => job.state === 'ready').length],
      [
        '已取消',
        records.filter((job) => ['cancelled', 'unaccepted'].includes(job.state))
          .length,
      ],
    ] as const
    return {
      kind,
      label: kind === 'video' ? '视频任务' : '配音任务',
      summary:
        counters
          .filter(([, count]) => count)
          .map(([label, count]) => `${label} ${count}`)
          .join(' · ') || '暂无任务',
    }
  })
  return {
    rows,
    total: relevant.length,
    active: relevant.some((job) => activeStates.includes(job.state)),
    unresolved: relevant.some((job) => unresolvedStates.includes(job.state)),
    failed: relevant.filter((job) => job.state === 'failed').length,
  }
}
