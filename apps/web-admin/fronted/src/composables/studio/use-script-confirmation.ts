import { createUuid } from '@/utils/uuid'
import { computed, ref } from 'vue'
import type { StudioProject } from '@/types/studio/studio'
import { preparationApi } from '@/api/studio/preparation-api'

/** 用户审阅后确认当前剧本；保存失败、期间内容变化和未知回执均不跳转或丢草稿。 */
export function useScriptConfirmation(options: {
  project: () => StudioProject
  readonly: () => boolean
  save: () => Promise<void>
  confirmed: () => void
}) {
  const open = ref(false),
    busy = ref(false),
    error = ref('')
  let fingerprint = '',
    intent: { signature: string; key: string } | undefined
  const content = () =>
    JSON.stringify([
      options.project().document.script,
      options.project().document.adaptationMode,
      options.project().document.scenes,
    ])
  const changed = computed(() => open.value && fingerprint !== content())
  function review() {
    fingerprint = content()
    error.value = ''
    open.value = true
  }
  async function confirm() {
    if (
      busy.value ||
      options.readonly() ||
      changed.value ||
      options.project().proposal
    )
      return
    busy.value = true
    error.value = ''
    try {
      await options.save()
      if (fingerprint !== content())
        throw new Error('剧本内容已更新，请返回重新审阅。')
      const project = options.project()
      if (!project.document.script.trim()) throw new Error('请先补充故事原稿。')
      const signature = JSON.stringify([
        project.id,
        project.revision,
        fingerprint,
      ])
      if (intent?.signature !== signature)
        intent = { signature, key: createUuid() }
      await preparationApi.confirm(project.id, 'script', {
        revision: project.revision,
        requestKey: intent.key,
        decision: 'confirmed',
        acknowledged: true,
        reason: '',
        waived: [],
        shots: [],
      })
      intent = undefined
      open.value = false
      options.confirmed()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      busy.value = false
    }
  }
  return { open, busy, error, changed, review, confirm }
}
