<script setup lang="ts">
import { computed } from 'vue'
import { membershipApi } from '@/api/billing/membership-api'
import { useResource } from '@/composables/use-resource'
import { usePreferences } from '@/store/modules/preferences'
/** 预检展示当前余额下的预计分摊，最终扣点由服务端确认事务决定。 */
const props = defineProps<{ points: number }>()
const { tr } = usePreferences()
const { data } = useResource(membershipApi.wallet)
const member = computed(() =>
  Math.min(
    props.points,
    data.value?.quota?.weeklyRemaining ?? 0,
    data.value?.quota?.monthlyRemaining ?? 0,
  ),
)
const regular = computed(() =>
  Math.min(
    props.points - member.value,
    data.value?.ordinaryPoints ??
      (data.value?.availablePoints ?? 0) - (data.value?.cardPoints ?? 0),
  ),
)
const card = computed(() =>
  Math.min(
    props.points - member.value - regular.value,
    data.value?.cardPoints ?? 0,
  ),
)
</script>
<template>
  <small
    v-if="data && !data.unlimited && (card > 0 || member > 0)"
    class="billing-note"
    >{{
      member
        ? tr(
            '预计使用会员 ' +
              member +
              ' 点、普通创作点 ' +
              regular +
              ' 点、额度卡 ' +
              card +
              ' 点。',
            'Estimated use: ' +
              member +
              ' membership, ' +
              regular +
              ' regular and ' +
              card +
              ' card credits.',
          )
        : tr(
            '预计使用普通创作点 ' +
              regular +
              ' 点，额度卡抵扣 ' +
              card +
              ' 点。',
            'Estimated split: ' +
              regular +
              ' regular credits and ' +
              card +
              ' card credits.',
          )
    }}</small
  >
</template>
