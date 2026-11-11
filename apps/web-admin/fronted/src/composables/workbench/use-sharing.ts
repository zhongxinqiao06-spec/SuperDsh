import { ref, watch, onScopeDispose, type Ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import { shareApi, type SessionShare } from '@/api/workbench/share-api'
import { errorMessage } from '@/utils/errors'

/** 会话分享管理随选择代际清理，公开链接使用 Hash 路由兼容静态前端。 */
export function useSharing(session: Ref<string>) {
  const items = ref<SessionShare[]>([]),
    messageId = ref(''),
    open = ref(false),
    busy = ref(false),
    error = ref('')
  let generation = 0,
    abort = new AbortController()
  async function load() {
    const current = generation,
      id = session.value
    if (!id) return
    const result = await shareApi.list(id, abort.signal)
    if (current === generation) items.value = result.items
  }
  async function run(action: () => Promise<void>) {
    const current = generation
    busy.value = true
    error.value = ''
    try {
      await action()
    } catch (cause) {
      if (
        current === generation &&
        !abort.signal.aborted &&
        cause !== 'cancel' &&
        cause !== 'close'
      )
        error.value = errorMessage(cause)
    } finally {
      if (current === generation) busy.value = false
    }
  }
  async function show(itemId = '') {
    messageId.value = itemId
    open.value = true
    await run(load)
  }
  async function create() {
    const current = generation
    await run(async () => {
      await shareApi.create(session.value, messageId.value || undefined)
      if (current === generation) await load()
    })
  }
  async function revoke(id: string) {
    const current = generation
    await run(async () => {
      await ElMessageBox.confirm(
        '撤销后，任何人都无法继续通过此链接查看快照。',
        '撤销分享',
        { type: 'warning' },
      )
      if (current !== generation) return
      await shareApi.revoke(id)
      await load()
    })
  }
  function url(item: SessionShare) {
    const value = new URL(location.href)
    value.pathname = '/'
    value.search = ''
    value.hash = item.url
    return value.toString()
  }
  watch(session, () => {
    generation++
    abort.abort()
    abort = new AbortController()
    items.value = []
    messageId.value = ''
    open.value = false
    busy.value = false
    error.value = ''
  })
  onScopeDispose(() => {
    generation++
    abort.abort()
  })
  return { items, messageId, open, busy, error, show, create, revoke, url }
}
