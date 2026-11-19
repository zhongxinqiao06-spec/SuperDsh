import { onScopeDispose, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import { ElMessageBox } from 'element-plus'

/** 切集、切区和离开都先处理当前草稿；关闭确认框不等同于放弃。 */
export function useSeriesDraftGuard(
  dirty: () => boolean,
  save: () => Promise<boolean>,
) {
  async function leave() {
    if (!dirty()) return true
    try {
      await ElMessageBox.confirm(
        '当前修改尚未保存。可以保存后继续，也可以放弃本次输入。',
        '处理未保存的修改',
        {
          confirmButtonText: '保存并继续',
          cancelButtonText: '放弃修改',
          distinguishCancelAndClose: true,
        },
      )
      return await save()
    } catch (action) {
      return action === 'cancel'
    }
  }
  function protect(event: BeforeUnloadEvent) {
    if (dirty()) {
      event.preventDefault()
      event.returnValue = ''
    }
  }
  watch(
    dirty,
    (value) => {
      if (value) window.addEventListener('beforeunload', protect)
      else window.removeEventListener('beforeunload', protect)
    },
    { immediate: true },
  )
  onScopeDispose(() => window.removeEventListener('beforeunload', protect))
  onBeforeRouteLeave(leave)
  onBeforeRouteUpdate((to, from) => to.fullPath === from.fullPath || leave())
  return { leave }
}
