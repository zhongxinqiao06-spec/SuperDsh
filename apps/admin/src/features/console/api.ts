import { apiClient } from '@/lib/api'
import type { MenuNode, MenusResponse, NavigationResponse } from './types'

export const NAVIGATION_CHANGED_EVENT = 'superdsh:navigation-changed'

async function updateNavigation(request: Promise<MenusResponse>) {
  const result = await request
  if (typeof window !== 'undefined')
    window.dispatchEvent(new Event(NAVIGATION_CHANGED_EVENT))
  return result
}

export const consoleApi = {
  navigation: () => apiClient.get<NavigationResponse>('/navigation'),
  menus: () => apiClient.get<MenusResponse>('/admin/menus'),
  saveMenus: (version: number, items: MenuNode[]) =>
    updateNavigation(
      apiClient.put<MenusResponse>('/admin/menus', { version, items }),
    ),
  resetMenus: (version: number) =>
    updateNavigation(
      apiClient.post<MenusResponse>('/admin/menus/reset', { version }),
    ),
}
