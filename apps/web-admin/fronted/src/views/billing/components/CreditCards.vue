<script setup lang="ts">
import { ref, watch } from 'vue'
import { operationsApi } from '@/api/billing/operations-api'
import { membershipApi } from '@/api/billing/membership-api'
import { useResource } from '@/composables/use-resource'
import { usePreferences } from '@/store/modules/preferences'
import { billingTime } from '@/utils/billing/change-labels'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import CreditTicket from './CreditTicket.vue'
/** 历史快照与卡的账本余额独立显示，卡种调整后仍按领卡时的面额呈现。 */
const props = defineProps<{ owner?: string }>()
const { tr } = usePreferences()
const page = ref(1)
const { data, loading, error, reload } = useResource((signal) =>
  props.owner
    ? operationsApi.cards(props.owner, page.value, signal)
    : membershipApi.cards(page.value, signal),
)
watch(page, () => {
  data.value = null
  void reload()
})
</script>
<template>
  <section class="stack">
    <ResourceStatus
      :loading="loading"
      :error="error"
      :has-data="!!data"
      :empty="data?.items.length === 0"
      :empty-title="tr('暂无额度卡', 'No credit cards yet')"
      @retry="reload"
    />
    <ul v-if="data?.items.length" class="issued-tickets">
      <li v-for="card in data.items" :key="card.id">
        <CreditTicket
          :name="card.name"
          :image="card.image"
          :points="card.granted"
        />
        <div class="issued-ticket-info">
          <div class="issued-ticket-heading">
            <h3>
              {{
                card.name ??
                card.granted.toLocaleString() + tr(' 点额度卡', ' credit card')
              }}
            </h3>
            <span
              >{{ tr('可用', 'Available') }}
              <b>{{ card.availablePoints.toLocaleString() }}</b>
              {{ tr('点', 'credits') }}</span
            >
            <span
              >{{ tr('已用', 'Used') }} {{ card.usedPoints.toLocaleString() }}
              {{ tr('点', 'credits') }}</span
            >
          </div>
          <div class="ticket-progress-line">
            <span>{{ tr('剩余', 'Remaining') }}</span
            ><progress
              :aria-label="tr('卡内剩余', 'Card balance')"
              :value="card.availablePoints"
              :max="card.granted"
            />
            <span
              >{{
                Math.round((card.availablePoints / card.granted) * 100)
              }}%</span
            >
          </div>
          <small
            >{{ tr('到期', 'Expires') }} · {{ billingTime(card.expiresAt) }}
            <template v-if="card.held">
              · {{ tr('任务占用', 'Held') }} {{ card.held.toLocaleString() }}
              {{ tr('点', 'credits') }}</template
            >
            <template v-if="card.status === 'expired'">
              · {{ tr('已过期', 'Expired') }}</template
            >
            <template v-if="card.status === 'spent'">
              · {{ tr('已用尽', 'Used up') }}</template
            >
          </small>
        </div>
      </li>
    </ul>
    <div v-if="page > 1 || data?.hasMore" class="toolbar">
      <el-button :disabled="page === 1 || loading" @click="page--">{{
        tr('上一页', 'Previous')
      }}</el-button>
      <span>{{ page }}</span>
      <el-button :disabled="!data?.hasMore || loading" @click="page++">{{
        tr('下一页', 'Next')
      }}</el-button>
    </div>
    <p class="ticket-footnote">
      {{
        tr(
          '先用会员额度，再用普通额度，最后自动用额度卡补差。多张卡优先使用最早到期的。',
          'Membership credits are used first, followed by regular credits. Cards cover the shortfall, earliest expiry first.',
        )
      }}
    </p>
  </section>
</template>
