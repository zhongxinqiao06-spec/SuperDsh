import { computed, onScopeDispose, reactive, ref, watch } from 'vue'
import { textEditApi } from '@/api/studio/text-edit-api'
import { useDirectorChat } from '@/composables/studio/use-director-chat'
import type { StudioProject } from '@/types/studio/studio'
import type { TextEdit, TextEditTarget } from '@/types/studio/text-edit'

/** 两种编辑范围共享任务提交、恢复和局部撤回；采用期间锁定编辑，避免重新加载吞掉输入。 */
export function useTextEdit(options: {
  project: () => StudioProject
  active: () => boolean
  allowed: () => boolean
  target: () => TextEditTarget | undefined
  save: () => Promise<void>
  reload: () => Promise<void>
}) {
  const records = ref<TextEdit[]>([]),
    selected = ref(''),
    instruction = ref(''),
    suggestion = ref('')
  const busy = ref(false),
    error = ref(''),
    notice = ref('')
  const abort = new AbortController()
  const chat = useDirectorChat({
    project: options.project().id,
    existing: () =>
      records.value.find((item) => item.sessionId)?.sessionId ?? null,
    active: options.active,
    allowed: options.allowed,
    save: options.save,
    purpose: 'text-edit',
  })
  const current = computed(() =>
    records.value.find((item) => item.id === selected.value),
  )
  const suggestionDrafts = reactive(new Map<string, string>())
  const hasDraft = computed(
    () =>
      suggestionDrafts.size > 0 ||
      (!current.value && !!instruction.value.trim()) ||
      (current.value?.state === 'ready' &&
        suggestion.value !== current.value.suggestion),
  )
  // 关闭面板或切换记录保留尚未采用的手工建议，轮询不覆盖用户输入。
  watch(
    selected,
    (id, previous) => {
      const previousRecord = records.value.find((item) => item.id === previous)
      if (
        previousRecord?.state === 'ready' &&
        previousRecord.suggestion !== suggestion.value
      )
        suggestionDrafts.set(previous, suggestion.value)
      else suggestionDrafts.delete(previous)
      suggestion.value =
        suggestionDrafts.get(id) ??
        records.value.find((item) => item.id === id)?.suggestion ??
        ''
    },
    { flush: 'sync' },
  )
  let attempt: { signature: string; key: string } | undefined
  let resolveAttempt: { signature: string; key: string } | undefined
  let pollError = ''
  async function refresh() {
    const result = await textEditApi.list(options.project().id, abort.signal)
    if (!abort.signal.aborted) records.value = result
  }
  watch(
    () => current.value?.suggestion,
    (value) => {
      if (
        value !== null &&
        value !== undefined &&
        !suggestionDrafts.has(selected.value)
      )
        suggestion.value = value
    },
  )
  watch(options.target, () => {
    selected.value = ''
    instruction.value = ''
    suggestion.value = ''
    error.value = ''
    notice.value = ''
  })
  watch(
    options.active,
    (active, _, cleanup) => {
      if (!active) return
      let cancelled = false
      let timer: ReturnType<typeof setTimeout>
      async function poll() {
        try {
          if (!busy.value) {
            await refresh()
            if (error.value === pollError) error.value = ''
            pollError = ''
          }
        } catch (cause) {
          if (!cancelled) {
            pollError =
              '修改记录暂时无法读取，正在重连；当前建议已保留。' + String(cause)
            error.value = pollError
          }
        } finally {
          if (!cancelled) timer = setTimeout(poll, 2000)
        }
      }
      void poll()
      cleanup(() => {
        cancelled = true
        clearTimeout(timer)
      })
    },
    { immediate: true },
  )
  async function generate() {
    const target = options.target()
    if (
      busy.value ||
      chat.running.value ||
      !target ||
      !instruction.value.trim() ||
      !options.allowed()
    )
      return
    busy.value = true
    error.value = ''
    notice.value = ''
    try {
      await options.save()
      const p = options.project()
      if (p.document.script !== target.script)
        throw new Error('正文已变化，请重新选择需要修改的范围。')
      const body = {
        revision: p.revision,
        scope: target.scope,
        sceneId: target.sceneId,
        start: target.start,
        end: target.end,
        instruction: instruction.value.trim(),
      }
      const signature = JSON.stringify(body)
      if (attempt?.signature !== signature)
        attempt = { signature, key: crypto.randomUUID() }
      const record = await textEditApi.create(p.id, {
        ...body,
        requestKey: attempt.key,
      })
      await refresh()
      selected.value = record.id
      if (record.state === 'waiting')
        await chat.send(record.prompt, 'text-edit-' + record.id)
      if (record.state !== 'waiting' || !chat.error.value)
        notice.value = '建议完成后在这里对比，正文暂不改变。'
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      busy.value = false
    }
  }
  async function resolve(action: 'apply' | 'undo' | 'discard') {
    const edit = current.value
    if (busy.value || !edit || !options.allowed()) return
    busy.value = true
    error.value = ''
    notice.value = ''
    try {
      await options.save()
      const body = {
        revision: options.project().revision,
        action,
        ...(action === 'apply' ? { replacement: suggestion.value } : {}),
      }
      const signature = JSON.stringify([edit.id, body])
      if (resolveAttempt?.signature !== signature)
        resolveAttempt = { signature, key: crypto.randomUUID() }
      await textEditApi.resolve(options.project().id, edit.id, {
        ...body,
        requestKey: resolveAttempt.key,
      })
      suggestionDrafts.delete(edit.id)
      await options.reload()
      await refresh()
      resolveAttempt = undefined
      attempt = undefined
      notice.value =
        action === 'apply'
          ? '已采用并保存。关联分镜请核对，现有视频和配音均已保留。'
          : action === 'undo'
            ? '已撤回本次采用，其他编辑保持不变。'
            : '已放弃本次建议，迟到结果不会写入。'
      if (
        action === 'discard' &&
        edit.state === 'waiting' &&
        chat.running.value
      ) {
        try {
          await chat.interrupt()
        } catch {
          error.value =
            '建议已放弃，但暂未确认助手停止。迟到结果仍会被拒绝，请稍后查看进度。'
        }
      }
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      await refresh().catch(() => {})
    } finally {
      busy.value = false
    }
  }
  onScopeDispose(() => abort.abort())
  return {
    records,
    selected,
    instruction,
    suggestion,
    busy,
    error,
    notice,
    hasDraft,
    current,
    chat,
    generate,
    resolve,
  }
}
