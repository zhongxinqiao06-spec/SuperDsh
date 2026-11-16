import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { productOf } from '@/utils/studio/products'

/** 公共页面随路由继承当前产品；双产品登录与刷新使用同一上下文。 */
export function useCurrentProduct() {
  const route = useRoute()
  return computed(
    () =>
      productOf(route.meta.product) ??
      productOf(route.query.product) ??
      'office',
  )
}
