import { inject, nextTick, ref, watch } from 'vue'
import {
  matchedRouteKey,
  onBeforeRouteLeave,
  onBeforeRouteUpdate,
  type RouteLocationNormalized,
} from 'vue-router'
import { ElMessageBox } from 'element-plus'
import { productOf } from '@/utils/studio/products'
import { useAuthStore } from '@/store/modules/auth-store'
import { usePreferences } from '@/store/modules/preferences'

/** 产品切换以及浏览器回退都须先处理正在编辑的表单。保存复用当前表单的校验和提交。 */
export function useProductEditorGuard(state: {
  open: () => boolean
  dirty: () => boolean
  busy: () => boolean
  save: () => void
}) {
  const auth = useAuthStore()
  const { tr } = usePreferences()
  const confirming = ref(false)
  const routeProduct = (route: RouteLocationNormalized) =>
    productOf(route.meta.product) ?? productOf(route.query.product) ?? 'office'
  async function leave(
    to: RouteLocationNormalized,
    from: RouteLocationNormalized,
  ) {
    if (!state.open() || !auth.can('products.' + routeProduct(from)))
      return true
    const switching =
      to.path === '/products' ||
      (to.meta.console && routeProduct(from) !== routeProduct(to))
    if (!switching) return true
    if (state.busy()) return false
    if (!state.dirty()) return true
    if (confirming.value) return false
    confirming.value = true
    try {
      await ElMessageBox.confirm(
        tr(
          '要保存当前修改再切换工作台吗？',
          'Save your changes before switching workspaces?',
        ),
        tr('未保存的修改', 'Unsaved changes'),
        {
          confirmButtonText: tr('保存', 'Save'),
          cancelButtonText: tr('放弃修改', 'Discard'),
          distinguishCancelAndClose: true,
          closeOnClickModal: false,
          type: 'warning',
        },
      )
    } catch (action) {
      // Esc 或关闭提示继续编辑，只有明确选择放弃才允许离开。
      return action === 'cancel'
    } finally {
      confirming.value = false
    }
    state.save()
    await nextTick()
    if (!state.busy()) return !state.open()
    await new Promise<void>((resolve) => {
      const stop = watch(
        [state.busy, state.open],
        ([busy, open]) => {
          if (!busy || !open) {
            stop()
            resolve()
          }
        },
        { flush: 'post' },
      )
    })
    await nextTick()
    return !state.open()
  }
  if (inject(matchedRouteKey, null)) {
    onBeforeRouteLeave(leave)
    onBeforeRouteUpdate(leave)
  }
  return confirming
}
