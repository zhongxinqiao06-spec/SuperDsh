import type { StudioDocument } from '@/types/studio/studio'
import type { DirectorRequest } from '@/types/studio/director'

/** 场次摘要从稳定镜头引用派生，调整场次顺序不改动镜头或台词。 */
export function sceneSummary(document: StudioDocument, sceneId: string) {
  const shots = document.shots.filter((shot) => shot.sceneId === sceneId)
  return {
    shots,
    duration: shots.reduce((total, shot) => total + shot.duration, 0) / 1000,
    lines: shots.reduce((total, shot) => total + shot.lines.length, 0),
  }
}

/** 用任务语言表达目的，原文保护、建议审阅和收费生成边界始终保留。 */
export function directorInstruction(request: DirectorRequest): string {
  const task =
    request.action === 'draft'
      ? `请先读取本作品的制作规格，根据故事构想起草完整的短片剧本。故事构想：${request.brief.trim()}`
      : '请读取本作品已保存的剧本，按故事发生的地点、时间与情节转折整理场次，并提取角色、对白和分镜草案。'
  const protection =
    request.mode === 'original' && request.script.trim()
      ? '忠于原文：保留剧本原文与原对白，不自行改编。'
      : '改写内容必须作为建议提交，不能直接覆盖用户已有文本。'
  return [
    task,
    protection,
    '沿用已有场次、镜头和台词的稳定 ID，保留用户手工编辑、角色造型、配音与选片。请提交可审阅的作品方案，并说明本次增加或调整了什么。',
    '本次只整理剧本与方案，不生成图片、视频或配音；等待用户审阅采用后再继续。',
  ].join('\n')
}
