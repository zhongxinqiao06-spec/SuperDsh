import { request } from '@/utils/request'
import type { TextEdit } from '@/types/studio/text-edit'

const path = (id: string) =>
  '/studio/projects/' + encodeURIComponent(id) + '/text-edits'
/** 局部编辑只提交意图与采用动作；模型执行复用导演会话。 */
export const textEditApi = {
  list: (id: string, signal?: AbortSignal) =>
    request<TextEdit[]>(path(id), { signal }),
  create: (
    id: string,
    body: {
      revision: number
      requestKey: string
      scope: 'selection' | 'scene'
      sceneId?: string
      start: number
      end: number
      instruction: string
    },
  ) =>
    request<TextEdit & { prompt: string }>(path(id), { method: 'POST', body }),
  resolve: (
    id: string,
    edit: string,
    body: {
      revision: number
      requestKey: string
      action: 'apply' | 'undo' | 'discard'
      replacement?: string
    },
  ) =>
    request<{ revision: number; state: TextEdit['state'] }>(
      path(id) + '/' + encodeURIComponent(edit) + '/resolve',
      { method: 'POST', body },
    ),
}
