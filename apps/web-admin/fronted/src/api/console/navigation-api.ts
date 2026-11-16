import { request } from '@/utils/request'
import type {
  MenuNode,
  MenusResponse,
  NavigationResponse,
  Product,
} from '@/types/console/navigation'

/** 导航与编辑分别鉴权；写入带业务版本以检测并发覆盖。 */
export const navigationApi = {
  get: (product: Product | undefined, signal?: AbortSignal) =>
    request<NavigationResponse>('/navigation', { query: { product }, signal }),
  menus: (product: Product, signal?: AbortSignal) =>
    request<MenusResponse>('/admin/menus', { query: { product }, signal }),
  preview: (product: Product, roleId: string, signal?: AbortSignal) =>
    request<NavigationResponse>('/admin/menus/preview', {
      query: { product, roleId },
      signal,
    }),
  save: (product: Product, version: number, items: MenuNode[]) =>
    request<MenusResponse>('/admin/menus', {
      method: 'PUT',
      query: { product },
      body: { version, items },
    }),
  reset: (product: Product, version: number) =>
    request<MenusResponse>('/admin/menus/reset', {
      method: 'POST',
      query: { product },
      body: { version },
    }),
}
