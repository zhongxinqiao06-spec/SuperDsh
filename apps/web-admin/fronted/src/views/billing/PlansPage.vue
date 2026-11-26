<script setup lang="ts">
import { computed, ref } from 'vue'
import { membershipApi } from '@/api/billing/membership-api'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import SettingsCard from '@/components/settings/SettingsCard.vue'
import { useResource } from '@/composables/use-resource'
import { usePreferences } from '@/store/modules/preferences'
import '@/assets/styles/billing.css'
const { tr } = usePreferences()
const { data, loading, error, reload } = useResource(membershipApi.catalog)
const chosen = ref('')
const memberships = computed(
  () => data.value?.items.filter((p) => p.kind === 'membership') ?? [],
)
const extras = computed(
  () => data.value?.items.filter((p) => p.kind === 'addon') ?? [],
)
const selected = computed(
  () =>
    data.value?.items.find((p) => p.id === chosen.value) ??
    memberships.value[0] ??
    extras.value[0],
)
const money = (fen: number) =>
  '¥' + (fen / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })
</script>
<template>
  <section class="page settings-page billing-page">
    <PageHeader :title="tr('套餐与加购', 'Plans and top-ups')" />
    <ResourceStatus
      :loading="loading"
      :error="error"
      :empty="data?.items.length === 0"
      :empty-title="tr('暂无展示中的套餐', 'No plans listed')"
      @retry="reload"
    />
    <template v-if="data && selected">
      <SettingsCard
        v-if="memberships.length"
        :title="tr('会员套餐', 'Membership plans')"
        :description="
          data.sampleClipPoints === null
            ? tr('720P 示例费率待配置', '720p sample rate unavailable')
            : tr(
                '按通用 720P 费率估算，5 秒镜头 ' +
                  data.sampleClipPoints +
                  ' 点。',
                'At the standard 720p rate, a five-second shot costs ' +
                  data.sampleClipPoints +
                  ' credits.',
              )
        "
      >
        <div
          class="billing-plans"
          role="group"
          :aria-label="tr('会员套餐', 'Membership plans')"
        >
          <button
            v-for="plan in memberships"
            :key="plan.id"
            type="button"
            class="billing-option"
            :aria-pressed="plan.id === selected.id"
            @click="chosen = plan.id"
          >
            <strong>{{ plan.name }}</strong
            ><span class="billing-price"
              >{{ money(plan.priceFen) }}
              <small
                >/
                {{
                  plan.termUnit === 'month'
                    ? tr('月', 'month')
                    : tr('年', 'year')
                }}</small
              ></span
            >
            <span
              >{{ plan.points.toLocaleString() }}
              {{ tr('创作点', 'credits') }}</span
            >
            <small v-if="data.sampleClipPoints">{{
              tr(
                '约 ' +
                  Math.floor(plan.points / data.sampleClipPoints) +
                  ' 个示例镜头',
                'About ' +
                  Math.floor(plan.points / data.sampleClipPoints) +
                  ' sample shots',
              )
            }}</small>
          </button>
        </div>
      </SettingsCard>
      <SettingsCard
        v-if="extras.length"
        :title="tr('额度加购', 'Credit top-ups')"
        ><div class="billing-plans">
          <button
            v-for="plan in extras"
            :key="plan.id"
            type="button"
            class="billing-option"
            :aria-pressed="plan.id === selected.id"
            @click="chosen = plan.id"
          >
            <strong>{{ plan.name }}</strong
            ><span
              >{{ money(plan.priceFen) }} · {{ plan.points.toLocaleString() }}
              {{ tr('创作点', 'credits') }}</span
            >
            <small>{{
              plan.termUnit === 'year'
                ? tr('有效期一年', 'Valid for one year')
                : tr('有效期一个月', 'Valid for one month')
            }}</small>
          </button>
        </div></SettingsCard
      >
      <SettingsCard :title="tr('所选方案', 'Selected plan')">
        <p aria-live="polite">
          <strong>{{ selected.name }}</strong> ·
          {{ money(selected.priceFen) }} ·
          {{ selected.points.toLocaleString() }} {{ tr('创作点', 'credits') }}
        </p>
        <small v-if="!data.saleOpen" class="billing-note">{{
          tr(
            '内测期间由运营人工办理，自助购买尚未开放。',
            'During the trial, enrollment is handled by staff. Self-service purchases are closed.',
          )
        }}</small>
      </SettingsCard>
    </template>
  </section>
</template>
