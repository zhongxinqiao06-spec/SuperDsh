<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import type { Plan } from '@/types/billing/membership'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import MembershipPlanCard from './components/MembershipPlanCard.vue'
import { membershipApi } from '@/api/billing/membership-api'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import SettingsCard from '@/components/settings/SettingsCard.vue'
import { useResource } from '@/composables/use-resource'
import { usePreferences } from '@/store/modules/preferences'
import '@/assets/styles/billing.css'
const { tr } = usePreferences()
const { data, loading, error, reload } = useResource(membershipApi.catalog)
const contactPlan = ref<Plan | null>(null)
const contactQr = '/images/membership/admin-wechat.jpg'
const route = useRoute()
const memberships = computed(
  () => data.value?.items.filter((p) => p.kind === 'membership') ?? [],
)
const extras = computed(
  () => data.value?.items.filter((p) => p.kind === 'addon') ?? [],
)
const money = (fen: number) =>
  '¥' + (fen / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })
</script>
<template>
  <section class="page settings-page billing-page">
    <PageHeader :title="tr('选购会员', 'Choose a membership')" />
    <ResourceStatus
      :loading="loading"
      :error="error"
      :empty="data?.items.length === 0"
      :empty-title="tr('暂无展示中的套餐', 'No plans listed')"
      @retry="reload"
    />
    <template v-if="data">
      <template v-if="memberships.length">
        <p class="billing-note">
          {{
            tr(
              '使用会员额度时，同一笔消费同时计入周上限和月上限。达到任一上限后，优先使用普通余额，再用额度卡补差。',
              'Membership usage counts towards both limits. When either is reached, regular credits and then credit cards cover the shortfall.',
            )
          }}
        </p>
        <div
          class="membership-shop-gallery"
          role="group"
          :aria-label="tr('会员套餐', 'Membership plans')"
        >
          <MembershipPlanCard
            v-for="plan in memberships"
            :key="plan.id"
            :plan="plan"
            purchase
            :selected="plan.id === route.query.plan"
            @click="contactPlan = plan"
          />
        </div>
        <p class="billing-note">
          {{
            tr(
              '每个会员月从生效日计算，周额度每 7 天重置。',
              'Each membership month starts on the activation anniversary. The weekly limit resets every seven days within that month.',
            )
          }}
        </p>
      </template>
      <SettingsCard
        v-if="extras.length"
        :title="tr('额度加购', 'Credit top-ups')"
      >
        <div class="billing-plans">
          <div v-for="plan in extras" :key="plan.id" class="billing-option">
            <strong>{{ plan.name }}</strong>
            <span
              >{{ money(plan.priceFen) }} · {{ plan.points.toLocaleString() }}
              {{ tr('创作点', 'credits') }}</span
            >
            <small>{{
              plan.termUnit === 'year'
                ? tr('有效期一年', 'Valid for one year')
                : tr('有效期一个月', 'Valid for one month')
            }}</small>
            <el-button @click="contactPlan = plan">{{
              tr('购买加购包', 'Buy top-up')
            }}</el-button>
          </div>
        </div>
      </SettingsCard>
    </template>
    <ManagementDialog
      v-if="contactPlan"
      :model-value="true"
      readonly
      width="min(420px, calc(100vw - 32px))"
      :title="tr('联系管理员', 'Contact the administrator')"
      @update:model-value="!$event && (contactPlan = null)"
    >
      <div class="membership-contact">
        <p>
          {{
            contactPlan.kind === 'membership'
              ? tr(
                  '支付功能暂未开通，请联系管理员获取会员。',
                  'Online payments are unavailable. Contact the administrator for membership.',
                )
              : tr(
                  '支付功能暂未开通，请联系管理员办理额度加购。',
                  'Online payments are unavailable. Contact the administrator for a credit top-up.',
                )
          }}
        </p>
        <strong
          >{{ contactPlan.name }} · {{ money(contactPlan.priceFen)
          }}<template v-if="contactPlan.kind === 'addon'">
            · {{ contactPlan.points.toLocaleString() }}
            {{ tr('创作点', 'credits') }}</template
          ></strong
        >
        <span v-if="contactPlan.kind === 'membership'"
          >{{ tr('每周额度', 'Weekly limit') }}
          {{ contactPlan.weeklyPoints?.toLocaleString() ?? '—' }} ·
          {{ tr('每月额度', 'Monthly limit') }}
          {{ contactPlan.points.toLocaleString() }}</span
        >
        <div class="membership-contact-qr">
          <img
            :src="contactQr"
            :alt="tr('管理员微信二维码', 'Administrator’s WeChat QR code')"
            width="972"
            height="1444"
          />
        </div>
        <small>{{
          tr(
            '用微信扫一扫，或保存二维码后在微信中从相册识别。',
            'Scan in WeChat, or save the QR code and open it from your album in WeChat.',
          )
        }}</small>
      </div>
      <template #footer-leading>
        <a :href="contactQr" download="星桥会员管理员微信.jpg">{{
          tr('保存二维码', 'Save QR code')
        }}</a>
      </template>
    </ManagementDialog>
  </section>
</template>
<style scoped>
.membership-contact {
  display: grid;
  justify-items: center;
  gap: var(--space-3);
  text-align: center;
}
.membership-contact p {
  margin: 0;
}
.membership-contact small {
  color: var(--muted-foreground);
}
.membership-contact-qr {
  position: relative;
  width: min(100%, 250px);
  aspect-ratio: 1;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  background: white;
}
/* 按原始名片中的二维码位置取景，保留四边的扫码留白。 */
.membership-contact-qr img {
  position: absolute;
  width: 123%;
  max-width: none;
  height: auto;
  left: -11.5%;
  top: -47.5%;
}
</style>
