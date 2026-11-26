<script setup lang="ts">
import type { Plan } from '@/types/billing/membership'
import { usePreferences } from '@/store/modules/preferences'
import { computed } from 'vue'
const props = defineProps<{
  plan: Plan
  selected: boolean
  clipPoints: number | null
  recommended?: boolean
}>()
const { tr } = usePreferences()
const art = computed(() =>
  ['light', 'creator', 'pro'].includes(props.plan.sku)
    ? props.plan.sku
    : 'creator',
)
</script>
<template>
  <button type="button" class="membership-plan-card" :aria-pressed="selected">
    <span class="plan-art">
      <img
        :src="'/images/membership/' + art + '.webp'"
        alt=""
        width="800"
        height="500"
      />
      <span v-if="recommended" class="plan-recommended">{{
        tr('本次推荐', 'Recommended')
      }}</span>
    </span>
    <span class="plan-copy"
      ><strong>{{ plan.name }}</strong>
      <span class="plan-amount"
        >¥{{ (plan.priceFen / 100).toLocaleString() }}
        <small
          >/
          {{
            plan.termUnit === 'month' ? tr('月', 'mo') : tr('年', 'yr')
          }}</small
        ></span
      >
      <span
        >{{ plan.points.toLocaleString() }} {{ tr('创作点', 'credits') }}</span
      >
      <small v-if="clipPoints">{{
        tr(
          '约 ' + Math.floor(plan.points / clipPoints) + ' 个 720P 五秒镜头',
          'About ' +
            Math.floor(plan.points / clipPoints) +
            ' five-second 720p shots',
        )
      }}</small>
    </span>
  </button>
</template>
