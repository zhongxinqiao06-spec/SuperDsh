<script setup lang="ts">
import { computed, defineAsyncComponent, watch } from 'vue'
import { creditShortfall } from '@/store/modules/credit-shortfall'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import en from 'element-plus/es/locale/lang/en'
import { usePreferences } from '@/store/modules/preferences'
import { useAuthStore } from '@/store/modules/auth-store'
import { useDraftStore } from '@/store/modules/draft-store'
const CreditShortfallDialog = defineAsyncComponent(
  () => import('@/views/billing/components/CreditShortfallDialog.vue'),
)
/** 应用根只装配公共配置和账号隔离，不准备Agent或加载工作台业务。 */
const preferences = usePreferences(),
  auth = useAuthStore(),
  drafts = useDraftStore()
const locale = computed(() => (preferences.locale === 'zh-CN' ? zhCn : en))
watch(
  () => auth.generation,
  (generation) => {
    drafts.bind(generation)
    creditShortfall.value = null
  },
  { immediate: true },
)
</script>
<template>
  <el-config-provider :locale="locale"
    ><router-view /><CreditShortfallDialog v-if="creditShortfall"
  /></el-config-provider>
</template>
