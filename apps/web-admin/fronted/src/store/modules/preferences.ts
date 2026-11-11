import { onScopeDispose, ref, watch } from 'vue'
import { defineStore } from 'pinia'

type Locale = 'zh-CN' | 'en'
type Theme = 'light' | 'dark' | 'system'

/** 仅保存非敏感界面偏好；语言与主题不混入认证数据。 */
export const usePreferences = defineStore('preferences', () => {
  const read = (key: string): string | null => {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  }
  const locale = ref<Locale>(
    read('starbridge.locale') === 'en' ? 'en' : 'zh-CN',
  )
  const value = read('starbridge.theme')
  const sidebarSessions = ref(read('starbridge.sidebar-sessions') === 'true')
  const mobileSidebar = ref(read('starbridge.mobile-sidebar') !== 'false')
  const theme = ref<Theme>(
    value === 'dark' || value === 'light' ? value : 'system',
  )
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const apply = () => {
    document.documentElement.classList.toggle(
      'dark',
      theme.value === 'dark' || (theme.value === 'system' && media.matches),
    )
    document.documentElement.lang = locale.value
    try {
      localStorage.setItem('starbridge.locale', locale.value)
      localStorage.setItem('starbridge.theme', theme.value)
      localStorage.setItem(
        'starbridge.sidebar-sessions',
        String(sidebarSessions.value),
      )
      localStorage.setItem(
        'starbridge.mobile-sidebar',
        String(mobileSidebar.value),
      )
    } catch {
      /* 存储不可用仍保留本次页面偏好。 */
    }
  }
  watch([locale, theme, sidebarSessions, mobileSidebar], apply, {
    immediate: true,
  })
  media.addEventListener('change', apply)
  onScopeDispose(() => media.removeEventListener('change', apply))
  const tr = (chinese: string, english: string): string =>
    locale.value === 'zh-CN' ? chinese : english
  return { locale, theme, sidebarSessions, mobileSidebar, tr }
})
