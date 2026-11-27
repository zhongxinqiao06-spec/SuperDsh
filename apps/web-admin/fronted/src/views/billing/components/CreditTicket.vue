<script setup lang="ts">
import { computed } from 'vue'
import { usePreferences } from '@/store/modules/preferences'
import '@/assets/styles/credit-tickets.css'

/** 票面只绘制背景，面额来自当前草稿或已发卡快照。 */
const props = defineProps<{
  image?: string | null
  points: number
  name?: string | null
}>()
const { tr } = usePreferences()
const amount = computed(() => props.points.toLocaleString())
</script>

<template>
  <div
    class="credit-ticket"
    role="img"
    :aria-label="
      (name || tr('额度卡', 'Credit card')) +
      ' · ' +
      amount +
      tr(' 创作点', ' credits')
    "
  >
    <img v-if="image" :src="image" alt="" decoding="async" />
    <span class="credit-ticket-face" aria-hidden="true">
      <strong :class="{ 'long-amount': amount.length > 5 }">{{
        amount
      }}</strong>
      <small>{{ tr('创作点', 'credits') }}</small>
    </span>
  </div>
</template>
