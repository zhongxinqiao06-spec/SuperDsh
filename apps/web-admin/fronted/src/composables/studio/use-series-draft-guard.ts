import { onScopeDispose, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import { ElMessageBox } from 'element-plus'

/** 切集、切区和离开都先处理当前草稿；关闭确认框不等同于放弃。 */
export function useSeriesDraftGuard(
  dirty: () => boolean,
  save?: () => Promise<boolean>,
  busy: () => boolean = () => false,
) {
  async function leave() {
    if (busy()) return false
    if (!dirty()) return true
    // 新建草稿只有显式提交才建立作品。离开时只允许放弃或留在当前页。
    if (!save) {
      return ElMessageBox.confirm(
        '离开后将丢失本次填写的内容。',
        '未保存的修改',
        {
          confirmButtonText: '放弃修改',
          cancelButtonText: '继续编辑',
          closeOnClickModal: false,
          type: 'warning',
        },
      ).then(
        () => true,
        () => false,
      )
    }
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
    if (dirty() || busy()) {
      event.preventDefault()
      event.returnValue = ''
    }
  }
  watch(
    [dirty, busy],
    ([changed, pending]) => {
      if (changed || pending) window.addEventListener('beforeunload', protect)
      else window.removeEventListener('beforeunload', protect)
    },
    { immediate: true },
  )
  onScopeDispose(() => window.removeEventListener('beforeunload', protect))
  onBeforeRouteLeave(leave)
  onBeforeRouteUpdate((to, from) => to.fullPath === from.fullPath || leave())
  return { leave }
}
