<script setup lang="ts">
import { computed, ref, watch } from 'vue'
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
const chosen = ref('')
const contactPlan = ref<Plan | null>(null)
const contactQr = '/images/membership/admin-wechat.jpg'
const route = useRoute()
watch(
  () => route.query.plan,
  (id) => {
    chosen.value = typeof id === 'string' ? id : ''
  },
  { immediate: true },
)
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
          class="membership-card-grid"
          role="group"
          :aria-label="tr('会员套餐', 'Membership plans')"
        >
          <MembershipPlanCard
            v-for="plan in memberships"
            :key="plan.id"
            :plan="plan"
            :selected="plan.id === selected.id"
            :clip-points="data.sampleClipPoints"
            @click="chosen = plan.id"
          />
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
      <SettingsCard
        :title="tr('所选方案', 'Selected plan')"
        :description="
          selected.name +
          ' · ' +
          money(selected.priceFen) +
          ' · ' +
          selected.points.toLocaleString() +
          tr(' 创作点', ' credits')
        "
      >
        <template #action>
          <el-button type="primary" @click="contactPlan = selected">{{
            selected.kind === 'membership'
              ? tr('购买会员', 'Buy membership')
              : tr('购买加购包', 'Buy top-up')
          }}</el-button>
        </template>
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
          >{{ contactPlan.name }} · {{ money(contactPlan.priceFen) }} ·
          {{ contactPlan.points.toLocaleString() }}
          {{ tr('创作点', 'credits') }}</strong
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
