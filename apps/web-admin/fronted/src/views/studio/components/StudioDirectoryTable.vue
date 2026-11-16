<script setup lang="ts">
import DataTable from '@/components/management/DataTable.vue'
import ManagementList from '@/components/management/ManagementList.vue'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'

/** 三个创作目录沿用管理端主列表、窄屏卡片、空态与底部分页。 */
defineProps<{
  label: string
  columns: string[]
  total: number
  empty: string
  loading: boolean
  error: string
}>()
const page = defineModel<number>('page', { required: true })
const pageSize = defineModel<number>('pageSize', { required: true })
defineEmits<{ retry: [] }>()
</script>
<template>
  <ResourceStatus
    :loading="loading"
    :has-data="total > 0"
    :error="error"
    @retry="$emit('retry')"
  />
  <ManagementList :page="page" :page-size="pageSize">
    <DataTable mobile-cards :label="label" :busy="loading">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column" scope="col">
            {{ column }}
          </th>
        </tr>
      </thead>
      <tbody>
        <slot />
        <tr v-if="!loading && !error && !total">
          <td :colspan="columns.length" class="empty-cell">{{ empty }}</td>
        </tr>
      </tbody>
    </DataTable>
    <template #pagination>
      <ManagementPagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="total"
        :loading="loading"
        :page-sizes="[10, 20, 50]"
      />
    </template>
  </ManagementList>
</template>
<style scoped>
:deep(td) {
  overflow-wrap: anywhere;
}
:deep(td small) {
  display: block;
  color: var(--muted-foreground);
}
</style>
