<script setup lang="ts">
import { computed } from 'vue'
import type { Plan } from '@/types/billing/membership'
import { usePreferences } from '@/store/modules/preferences'

const props = defineProps<{
  plan: Plan
  selected: boolean
  purchase?: boolean
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
  <button
    type="button"
    class="membership-plan-card membership-poster"
    :class="{
      'membership-poster--purchase': purchase,
      'membership-poster--selected': selected,
    }"
    :aria-current="purchase && selected ? 'true' : undefined"
    :aria-pressed="purchase ? undefined : selected"
    :aria-label="
      purchase
        ? tr('联系管理员开通', 'Contact the administrator for ') + plan.name
        : undefined
    "
  >
    <span class="membership-poster-art">
      <img
        :src="'/images/membership/' + art + '.webp'"
        alt=""
        width="960"
        height="720"
      />
      <span v-if="recommended" class="plan-recommended">{{
        tr('本次推荐', 'Recommended')
      }}</span>
    </span>
    <span class="membership-poster-copy">
      <span class="membership-poster-heading">
        <strong>{{ plan.name }}</strong>
        <span class="membership-poster-price"
          >¥{{ (plan.priceFen / 100).toLocaleString() }}
          <small
            >/
            {{
              plan.termUnit === 'month' ? tr('月', 'mo') : tr('年', 'yr')
            }}</small
          >
        </span>
      </span>
      <span class="membership-poster-row">
        <span>{{ tr('每周额度', 'Weekly limit') }}</span>
        <b
          >{{ plan.weeklyPoints?.toLocaleString() ?? '—' }}
          <small>{{ tr('点', 'credits') }}</small></b
        >
      </span>
      <span class="membership-poster-row">
        <span>{{ tr('每月额度', 'Monthly limit') }}</span>
        <b
          >{{ plan.points.toLocaleString() }}
          <small>{{ tr('点', 'credits') }}</small></b
        >
      </span>
      <span v-if="purchase" class="membership-poster-action">{{
        tr('联系管理员开通', 'Contact the administrator')
      }}</span>
    </span>
  </button>
</template>
<style src="@/assets/styles/membership-posters.css"></style>
