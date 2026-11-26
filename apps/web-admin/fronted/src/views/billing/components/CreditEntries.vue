<script setup lang="ts">
import { ref, watch } from 'vue'
import { membershipApi } from '@/api/billing/membership-api'
import { useResource } from '@/composables/use-resource'
import { usePreferences } from '@/store/modules/preferences'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import { billingLabel, signedPoints } from '@/utils/billing/labels'
import { dateTimeLabel } from '@/utils/date-time'
import EntryDetailDialog from './EntryDetailDialog.vue'
const { tr } = usePreferences()
const kind = ref('all')
const days = ref(0)
const since = ref('')
const cursors = ref<(string | null)[]>([null])
const selected = ref('')
const { data, loading, error, reload } = useResource((signal) =>
  membershipApi.entries(
    cursors.value.at(-1) ?? null,
    kind.value === 'all' ? '' : kind.value,
    since.value,
    signal,
  ),
)
function resetFilters() {
  since.value = days.value
    ? new Date(Date.now() - days.value * 86400000).toISOString()
    : ''
  cursors.value = [null]
}
watch([kind, days], resetFilters)
watch(cursors, () => {
  data.value = null
  void reload()
})
function nextPage() {
  if (data.value?.nextCursor)
    cursors.value = [...cursors.value, data.value.nextCursor]
}
</script>
<template>
  <section class="stack">
    <div class="toolbar billing-filters">
      <label
        >{{ tr('变动类型', 'Entry type')
        }}<el-select v-model="kind" :aria-label="tr('变动类型', 'Entry type')">
          <el-option :label="tr('全部类型', 'All types')" value="all" />
          <el-option
            :label="tr('注册赠额', 'Registration credit')"
            value="registration_grant"
          /><el-option
            v-for="type in [
              'membership_grant',
              'usage_hold',
              'usage_charge',
              'usage_release',
              'gift',
              'card',
              'compensation',
              'topup',
            ]"
            :key="type"
            :label="billingLabel(type, tr)"
            :value="type"
          /> </el-select
      ></label>
      <label
        >{{ tr('时间范围', 'Date range')
        }}<el-select v-model="days" :aria-label="tr('时间范围', 'Date range')">
          <el-option :label="tr('全部时间', 'All time')" :value="0" /><el-option
            :label="tr('近 7 天', 'Last 7 days')"
            :value="7"
          />
          <el-option
            :label="tr('近 30 天', 'Last 30 days')"
            :value="30"
          /> </el-select
      ></label>
    </div>
    <ResourceStatus
      :loading="loading"
      :error="error"
      :empty="data?.items.length === 0"
      :empty-title="tr('暂无符合条件的流水', 'No matching entries')"
      @retry="reload"
    />
    <ul v-if="data?.items.length" class="billing-rows">
      <li v-for="entry in data.items" :key="entry.id">
        <div>
          <strong>{{ billingLabel(entry.kind, tr) }}</strong
          ><small>{{ dateTimeLabel(entry.createdAt) }}</small>
        </div>
        <div>
          <span
            >{{ tr('可用', 'Available') }}
            {{ signedPoints(entry.availableDelta) }}</span
          ><small
            >{{ tr('占用', 'Held') }} {{ signedPoints(entry.heldDelta) }}</small
          >
        </div>
        <el-button link @click="selected = entry.id">{{
          tr('查看详情', 'View details')
        }}</el-button>
      </li>
    </ul>
    <nav class="toolbar" :aria-label="tr('流水分页', 'Entry pagination')">
      <el-button
        :disabled="loading || cursors.length === 1"
        @click="cursors = cursors.slice(0, -1)"
        >{{ tr('上一页', 'Previous') }}</el-button
      >
      <span>{{
        tr('第 ' + cursors.length + ' 页', 'Page ' + cursors.length)
      }}</span>
      <el-button :disabled="loading || !data?.nextCursor" @click="nextPage">{{
        tr('下一页', 'Next')
      }}</el-button>
    </nav>
    <EntryDetailDialog
      v-if="selected"
      :key="selected"
      :entry-id="selected"
      @close="selected = ''"
    />
  </section>
</template>
