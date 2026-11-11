<script setup lang="ts">
import ManagementList from '@/components/management/ManagementList.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import DateTime from '@/components/base/DateTime.vue'
import FilterBar from '@/components/management/FilterBar.vue'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
import { ref } from 'vue'
import { systemApi } from '@/api/service/system-api'
import { useResource } from '@/composables/use-resource'
import { usePreferences } from '@/store/modules/preferences'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import type { AuditEntry } from '@/types/service/system'
const { tr } = usePreferences(),
  page = ref(1),
  size = ref(10),
  search = ref(''),
  action = ref(''),
  selected = ref<AuditEntry | null>(null)
const resource = useResource((signal) =>
  systemApi.audits(page.value, size.value, search.value, action.value, signal),
)
function filter() {
  page.value = 1
  void resource.reload()
}
</script>
<template>
  <section class="page paged-page management-page">
    <PageHeader :title="tr('审计日志', 'Audit log')" />
    <FilterBar class="toolbar" @submit="filter">
      <el-input
        v-model="search"
        :placeholder="tr('搜索动作或对象', 'Search actions or targets')"
        clearable
      /><el-input
        v-model="action"
        :placeholder="tr('精确动作筛选', 'Exact action filter')"
        clearable
      /><el-button native-type="submit">{{ tr('搜索', 'Search') }}</el-button
      ><el-button @click="resource.reload">{{
        tr('刷新', 'Refresh')
      }}</el-button>
    </FilterBar>
    <ResourceStatus
      :loading="resource.loading.value"
      :has-data="Boolean(resource.data.value)"
      :error="resource.error.value"
      @retry="resource.reload"
    /><ManagementList :page="page" :page-size="size">
      <el-table
        :data="resource.data.value?.events ?? []"
        :empty-text="
          resource.error.value
            ? '审计日志加载失败，请重试。'
            : resource.loading.value
              ? '正在加载审计日志…'
              : '暂无符合条件的记录。'
        "
        ><el-table-column
          prop="createdAt"
          :label="tr('时间', 'Time')"
          min-width="150"
          ><template #default="{ row }"
            ><DateTime :value="row.createdAt" /></template></el-table-column
        ><el-table-column
          prop="actorUsername"
          :label="tr('操作人', 'Actor')"
        /><el-table-column
          prop="action"
          :label="tr('动作', 'Action')"
          min-width="200"
          show-overflow-tooltip
        /><el-table-column
          prop="targetId"
          :label="tr('对象', 'Target')"
          min-width="150"
          show-overflow-tooltip
        /><el-table-column :label="tr('详情', 'Details')"
          ><template #default="{ row }"
            ><el-button link @click="selected = row">{{
              tr('查看', 'View')
            }}</el-button></template
          ></el-table-column
        ></el-table
      >
      <template #pagination>
        <ManagementPagination
          v-model:current-page="page"
          v-model:page-size="size"
          :total="resource.data.value?.total ?? 0"
          :page-sizes="[10, 20, 50]"
          @change="resource.reload"
        />
      </template> </ManagementList
    ><el-dialog
      :model-value="selected !== null"
      :title="tr('审计详情', 'Audit details')"
      @update:model-value="selected = null"
      ><dl v-if="selected" class="details">
        <dt>{{ tr('操作人', 'Actor') }}</dt>
        <dd>{{ selected.actorUsername || selected.actorId || '—' }}</dd>
        <dt>{{ tr('动作', 'Action') }}</dt>
        <dd>{{ selected.action }}</dd>
        <dt>{{ tr('对象', 'Target') }}</dt>
        <dd>{{ selected.targetId || '—' }}</dd>
        <dt>{{ tr('时间', 'Time') }}</dt>
        <dd><DateTime :value="selected.createdAt" /></dd>
        <template v-for="(value, key) in selected?.detail" :key="key"
          ><dt>{{ key }}</dt>
          <dd>
            {{ typeof value === 'object' ? JSON.stringify(value) : value }}
          </dd></template
        >
      </dl></el-dialog
    >
  </section>
</template>
