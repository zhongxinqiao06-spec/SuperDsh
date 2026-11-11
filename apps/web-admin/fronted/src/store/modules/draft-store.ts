import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'
import type { UploadedAttachment } from '@/types/workbench/models'

/** 草稿只属于当前账号代际；File和预览地址从不写浏览器存储。 */
export interface WorkspaceDraft {
  text: string
  files: File[]
  deviceId: string
  modelId: string
  /** 权限选择与该会话草稿绑定，切换会话不能携带上一会话的权限。 */
  permissionId?: string
  submission?: {
    id: string
    signature: string
    attachments: UploadedAttachment[]
  }
}

/** 跨模块保留草稿；账号切换立即撤销旧预览及异步写入资格。 */
export const useDraftStore = defineStore('workbench-drafts', () => {
  const generation = ref(-1)
  const drafts = reactive(new Map<string, WorkspaceDraft>())
  const previews = new Set<string>()
  function bind(next: number): void {
    if (generation.value === next) return
    for (const url of previews) URL.revokeObjectURL(url)
    previews.clear()
    drafts.clear()
    generation.value = next
  }
  function draft(key: string): WorkspaceDraft {
    let value = drafts.get(key)
    if (!value) {
      value = reactive({
        text: '',
        files: [],
        deviceId: '',
        modelId: '',
        permissionId: '',
      })
      drafts.set(key, value)
    }
    return value
  }
  function preview(file: File): string {
    const url = URL.createObjectURL(file)
    previews.add(url)
    return url
  }
  /** 删除历史时只清除该会话草稿，其他窗口的新草稿保持原样。 */
  function remove(key: string): void {
    drafts.delete(key)
  }
  return { generation, bind, draft, preview, remove }
})
