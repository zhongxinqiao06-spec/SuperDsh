<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { creditShortfall } from '@/store/modules/credit-shortfall'
import { useResource } from '@/composables/use-resource'
import { usePreferences } from '@/store/modules/preferences'
import { membershipApi } from '@/api/billing/membership-api'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import MembershipPlanCard from './MembershipPlanCard.vue'
import '@/assets/styles/billing.css'
const { tr } = usePreferences()
const router = useRouter(),
  route = useRoute()
const { data, loading, error, reload } = useResource(membershipApi.catalog)
const plans = computed(() =>
  (data.value?.items ?? [])
    .filter((p) => p.kind === 'membership')
    .sort((a, b) => a.priceFen - b.priceFen),
)
const gap = computed(() =>
  creditShortfall.value
    ? creditShortfall.value.requiredPoints -
      creditShortfall.value.availablePoints
    : 0,
)
const recommended = computed(() =>
  plans.value.find((p) => p.points >= gap.value),
)
const choice = ref('')
const selected = computed(
  () =>
    plans.value.find((p) => p.id === choice.value) ??
    recommended.value ??
    plans.value[0],
)
async function seePlans() {
  const product =
    route.meta.product === 'entertainment' ||
    route.query.product === 'entertainment'
      ? 'entertainment'
      : 'office'
  const plan = selected.value?.id
  creditShortfall.value = null
  await router.push({
    path: '/account/plans',
    query: { product, ...(plan ? { plan } : {}) },
  })
}
</script>
<template>
  <el-dialog
    :model-value="!!creditShortfall"
    :title="tr('创作点不足', 'More credits needed')"
    class="membership-offer"
    width="min(840px, calc(100vw - 24px))"
    append-to-body
    @update:model-value="
      (v: boolean) => {
        if (!v) creditShortfall = null
      }
    "
  >
    <div v-if="creditShortfall" class="stack">
      <p class="offer-summary">
        {{
          tr(
            '本次生成需要 ' +
              creditShortfall.requiredPoints +
              ' 点，当前可用 ' +
              creditShortfall.availablePoints +
              ' 点，还差 ' +
              gap +
              ' 点。',
            'This generation costs ' +
              creditShortfall.requiredPoints +
              ' credits. Available: ' +
              creditShortfall.availablePoints +
              '. Shortfall: ' +
              gap +
              '.',
          )
        }}
      </p>
      <ResourceStatus
        :loading="loading"
        :error="error"
        :empty="!!data && !plans.length"
        :empty-title="tr('暂无在售会员套餐', 'No memberships available')"
        @retry="reload"
      />
      <div
        v-if="plans.length"
        class="membership-card-grid"
        role="group"
        :aria-label="tr('推荐会员套餐', 'Suggested memberships')"
      >
        <MembershipPlanCard
          v-for="p in plans"
          :key="p.id"
          :plan="p"
          :selected="p.id === selected?.id"
          :recommended="p.id === recommended?.id"
          :clip-points="data?.sampleClipPoints ?? null"
          @click="choice = p.id"
        />
      </div>
      <small v-if="data && !data.saleOpen" class="billing-note">{{
        tr(
          '当前会员由运营人工办理，到账后可返回作品继续生成。',
          'Memberships are activated by staff. Return to your work once credits arrive.',
        )
      }}</small>
    </div>
    <template #footer
      ><el-button @click="creditShortfall = null">{{
        tr('返回作品', 'Back to work')
      }}</el-button
      ><el-button type="primary" @click="seePlans">{{
        tr('查看会员办理', 'View membership options')
      }}</el-button></template
    >
  </el-dialog>
</template>
