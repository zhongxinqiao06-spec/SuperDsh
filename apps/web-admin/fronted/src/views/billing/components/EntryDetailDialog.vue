<script setup lang="ts">
import { membershipApi } from '@/api/billing/membership-api'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import { useResource } from '@/composables/use-resource'
import { usePreferences } from '@/store/modules/preferences'
import { billingLabel, signedPoints } from '@/utils/billing/labels'
import { dateTimeLabel } from '@/utils/date-time'
const props = defineProps<{ entryId: string }>()
defineEmits<{ close: [] }>()
const { tr } = usePreferences()
const { data, loading, error, reload } = useResource((signal) =>
  membershipApi.detail(props.entryId, signal),
)
</script>
<template>
  <ManagementDialog
    :model-value="true"
    :title="tr('流水详情', 'Entry details')"
    readonly
    @update:model-value="!$event && $emit('close')"
  >
    <ResourceStatus :loading="loading" :error="error" @retry="reload" />
    <dl v-if="data" class="billing-details">
      <dt>{{ tr('变动类型', 'Type') }}</dt>
      <dd>{{ billingLabel(data.kind, tr) }}</dd>
      <dt>{{ tr('入账时间', 'Recorded at') }}</dt>
      <dd>{{ dateTimeLabel(data.createdAt) }}</dd>
      <dt>{{ tr('可用变动', 'Available change') }}</dt>
      <dd>{{ signedPoints(data.availableDelta) }}</dd>
      <dt>{{ tr('占用变动', 'Held change') }}</dt>
      <dd>{{ signedPoints(data.heldDelta) }}</dd>
      <dt>{{ tr('来源批次', 'Credit lot') }}</dt>
      <dd>{{ billingLabel(data.sourceKey, tr) }} · {{ data.lotId }}</dd>
      <dt>{{ tr('批次发放点数', 'Granted credits') }}</dt>
      <dd>{{ data.granted.toLocaleString() }}</dd>
      <dt>{{ tr('批次到期时间', 'Lot expiry') }}</dt>
      <dd>{{ dateTimeLabel(data.expiresAt) }}</dd>
      <dt>{{ tr('流水编号', 'Entry ID') }}</dt>
      <dd>{{ data.id }}</dd>
    </dl>
  </ManagementDialog>
</template>
