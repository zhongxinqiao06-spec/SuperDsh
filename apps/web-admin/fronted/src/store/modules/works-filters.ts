import { ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { useAuthStore } from '@/store/modules/auth-store'
import type { WorkMode } from '@/types/studio/works'

function defaults() {
  return {
    mode: 'all' as WorkMode | 'all',
    lifecycle: 'active',
    page: 1,
    pageSize: 10,
    search: '',
  }
}

/** 作品库仅在当前身份的页面往返间恢复检索条件，登出或切换账号即清空。 */
export const useWorksFilters = defineStore('studio-works-filters', () => {
  const auth = useAuthStore()
  const saved = ref(defaults())
  watch(
    () => auth.generation,
    () => {
      saved.value = defaults()
    },
    { flush: 'sync' },
  )
  return { saved }
})
