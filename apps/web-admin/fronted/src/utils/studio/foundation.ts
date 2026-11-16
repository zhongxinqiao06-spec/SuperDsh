import type { CreationDefaults, ProjectBrief } from '@/types/studio/foundation'
import type { StudioProject } from '@/types/studio/studio'

/** 只采集规格字段，防止把工程、任务和凭据混入修改请求。 */
export function projectBrief(value?: Partial<ProjectBrief>): ProjectBrief {
  return {
    title: value?.title ?? '',
    brief: value?.brief ?? '',
    aspectWidth: value?.aspectWidth ?? null,
    aspectHeight: value?.aspectHeight ?? null,
    targetDurationMs: value?.targetDurationMs ?? null,
    language: value?.language ?? null,
    styleBrief: value?.styleBrief ?? '',
  }
}
export function initialBrief(defaults: CreationDefaults): ProjectBrief {
  return projectBrief(defaults)
}
/** 阶段只表示当前内容的下一步，不把“填过字段”冒充制作确认。 */
export function nextFoundationStep(project: StudioProject) {
  if (!project.aspectWidth || !project.targetDurationMs)
    return { key: 'brief', label: '补充制作规格' }
  if (!project.document.script.trim())
    return { key: 'script', label: '填写剧本' }
  if (!project.document.assets.length)
    return { key: 'cast', label: '建立本片角色与场景' }
  if (!project.document.shots.length)
    return { key: 'storyboard', label: '规划分镜' }
  if (project.proposal) return { key: 'storyboard', label: '审阅导演草案' }
  return { key: 'storyboard', label: '检查分镜与台词' }
}
