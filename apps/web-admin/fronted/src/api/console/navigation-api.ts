import { request } from '@/utils/request'
import type {
  MenuNode,
  MenusResponse,
  NavigationResponse,
} from '@/types/console/navigation'

/** 导航与编辑分别鉴权；写入带业务版本以检测并发覆盖。 */
export const navigationApi = {
  get: (signal?: AbortSignal) =>
    request<NavigationResponse>('/navigation', { signal }),
  menus: (signal?: AbortSignal) =>
    request<MenusResponse>('/admin/menus', { signal }),
  save: (version: number, items: MenuNode[]) =>
    request<MenusResponse>('/admin/menus', {
      method: 'PUT',
      body: { version, items },
    }),
  reset: (version: number) =>
    request<MenusResponse>('/admin/menus/reset', {
      method: 'POST',
      body: { version },
    }),
}
