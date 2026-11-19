<script setup lang="ts">
import { useRoute } from 'vue-router'
import { ref } from 'vue'
import { useActiveNavigation } from '@/composables/use-active-navigation'
import type { StageState } from '@/types/studio/preparation'
/** 作品阶段导航与服务端确认状态共用一份展示，手机采用横向滚动。 */
const props = defineProps<{
  sections: readonly { key: string; title: string }[]
  active: string
  states: StageState[]
}>()
const route = useRoute()
const navigation = ref<HTMLElement>()
useActiveNavigation(navigation, () => props.active)
const labels: Record<string, string> = {
  confirmed: '已确认',
  skipped: '已略过',
  stale: '待更新',
  blocked: '待补充',
  needs_review: '待确认',
}
function stageLabel(key: string): string {
  return (
    labels[props.states.find((state) => state.key === key)?.status ?? ''] ??
    (props.active === key ? '当前步骤' : '随时可进入')
  )
}
</script>
<template>
  <nav ref="navigation" class="preparation-steps" aria-label="作品工作区">
    <router-link
      v-for="(item, index) in sections"
      :key="item.key"
      :aria-label="item.title"
      :aria-describedby="'studio-stage-' + item.key"
      :title="item.title + ' · ' + stageLabel(item.key)"
      :to="{ path: route.path, query: { ...route.query, section: item.key } }"
      :aria-current="active === item.key ? 'page' : undefined"
    >
      <span class="step-index">{{ String(index + 1).padStart(2, '0') }}</span>
      <span
        ><strong>{{ item.title }}</strong
        ><small :id="'studio-stage-' + item.key" class="visually-hidden">{{
          stageLabel(item.key)
        }}</small></span
      >
    </router-link>
  </nav>
</template>
