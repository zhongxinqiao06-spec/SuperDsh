<script setup lang="ts">
import { usePreferences } from '@/store/modules/preferences'
/** 未登记路由保持404，不自动回退为聊天页。 */
const { tr } = usePreferences()
</script>
<template>
  <main class="page">
    <el-result
      icon="warning"
      title="404"
      :sub-title="tr('页面不存在', 'Page not found')"
    >
      <template #extra>
        <router-link to="/overview">{{
          tr('返回总览', 'Back to overview')
        }}</router-link>
      </template>
    </el-result>
  </main>
</template>
