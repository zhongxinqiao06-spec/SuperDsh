import type { Product } from '@/types/console/navigation'

/** 产品上下文只接受系统注册的两个值；公共页面的链接可以被复制到新标签页。 */
export function productOf(value: unknown): Product | undefined {
  return value === 'office' || value === 'entertainment' ? value : undefined
}

/** 登录入口根据持久角色权限决定，显式进入既有办公链接时保留原目标。 */
export function productHome(permissions: readonly string[] = []): string {
  if (permissions.includes('products.entertainment'))
    return permissions.includes('products.office')
      ? '/products'
      : '/entertainment'
  return permissions.includes('products.office')
    ? '/office'
    : permissions.includes('settings.manage')
      ? '/overview'
      : '/account/profile'
}
