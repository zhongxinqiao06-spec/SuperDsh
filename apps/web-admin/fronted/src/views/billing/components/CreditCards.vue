<script setup lang="ts">
import { ref, watch } from 'vue'
import { membershipApi } from '@/api/billing/membership-api'
import { useResource } from '@/composables/use-resource'
import { usePreferences } from '@/store/modules/preferences'
import { billingTime } from '@/utils/billing/change-labels'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
/** 卡片独立分页，包括过期和用尽的卡；刷新余额时重新读取本人数据。 */
const { tr } = usePreferences()
const page = ref(1)
const { data, loading, error, reload } = useResource((signal) =>
  membershipApi.cards(page.value, signal),
)
watch(page, () => {
  data.value = null
  void reload()
})
</script>
<template>
  <section class="stack">
    <p class="billing-note">
      {{
        tr(
          '普通创作点优先使用。余额不足时自动用卡补足差额，多张卡优先用最早到期的。',
          'Regular credits are used first. Cards cover the shortfall, earliest expiry first.',
        )
      }}
    </p>
    <ResourceStatus
      :loading="loading"
      :error="error"
      :empty="data?.items.length === 0"
      :empty-title="tr('暂无额度卡', 'No credit cards yet')"
      @retry="reload"
    />
    <ul v-if="data?.items.length" class="billing-rows">
      <li v-for="card in data.items" :key="card.id">
        <div>
          <strong
            >{{ card.granted.toLocaleString() }}
            {{ tr('点额度卡', 'credit card') }}</strong
          >
          <small
            >{{ tr('到期', 'Expires') }} ·
            {{ billingTime(card.expiresAt) }}</small
          >
        </div>
        <div>
          <strong
            >{{ tr('可抵扣', 'Available') }}
            {{ card.availablePoints.toLocaleString() }}
            {{ tr('点', 'credits') }}</strong
          >
          <small
            >{{ tr('已用', 'Used') }} {{ card.usedPoints }} ·
            {{ tr('占用', 'Held') }} {{ card.held }}</small
          >
        </div>
        <span>{{
          {
            available: tr('可使用', 'Available'),
            held: tr('任务占用中', 'On hold'),
            spent: tr('已用尽', 'Used up'),
            expired: tr('已过期', 'Expired'),
          }[card.status]
        }}</span>
      </li>
    </ul>
    <div v-if="page > 1 || data?.hasMore" class="toolbar">
      <el-button :disabled="page === 1 || loading" @click="page--">{{
        tr('上一页', 'Previous')
      }}</el-button>
      <span>{{ page }}</span
      ><el-button :disabled="!data?.hasMore || loading" @click="page++">{{
        tr('下一页', 'Next')
      }}</el-button>
    </div>
  </section>
</template>
