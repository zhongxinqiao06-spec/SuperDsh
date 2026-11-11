<script setup lang="ts">
import { computed, watch } from 'vue'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import en from 'element-plus/es/locale/lang/en'
import { usePreferences } from '@/store/modules/preferences'
import { useAuthStore } from '@/store/modules/auth-store'
import { useDraftStore } from '@/store/modules/draft-store'
/** 应用根只装配公共配置和账号隔离，不准备Agent或加载工作台业务。 */
const preferences = usePreferences(),
  auth = useAuthStore(),
  drafts = useDraftStore()
const locale = computed(() => (preferences.locale === 'zh-CN' ? zhCn : en))
watch(
  () => auth.generation,
  (generation) => drafts.bind(generation),
  { immediate: true },
)
</script>
<template>
  <el-config-provider :locale="locale"><router-view /></el-config-provider>
</template>
