<script setup lang="ts">
import ManagementList from '@/components/management/ManagementList.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import FilterBar from '@/components/management/FilterBar.vue'
import DataTable from '@/components/management/DataTable.vue'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
import { useDeviceInventory } from '@/composables/devices/use-device-inventory'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
/** 平台设备运维只显示身份和连接状态，不暴露他人会话、文件或终端。 */
const vm = useDeviceInventory()
</script>
<template>
  <section class="page paged-page management-page">
    <PageHeader title="设备运维" />
    <FilterBar class="toolbar" @submit="vm.filter">
      <el-input
        v-model="vm.query.value"
        placeholder="搜索设备或用户"
        aria-label="搜索设备"
      /><el-button native-type="submit">搜索</el-button
      ><el-button @click="vm.resource.reload">刷新</el-button>
    </FilterBar>
    <ResourceStatus
      :loading="vm.resource.loading.value"
      :error="vm.resource.error.value"
      @retry="vm.resource.reload"
    /><el-alert
      v-if="vm.mutation.error.value"
      :title="vm.mutation.error.value"
      type="error"
      :closable="false"
    />
    <ManagementList :page="vm.page.value" :page-size="vm.pageSize.value">
      <DataTable mobile-cards label="数据列表">
        <thead>
          <tr>
            <th>设备</th>
            <th>所属用户</th>
            <th>运行信息</th>
            <th>连接状态</th>
            <th>最近在线</th>
            <th>运维操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="device in vm.resource.data.value?.devices ?? []"
            :key="device.id"
          >
            <td>
              <strong>{{ device.name }}</strong
              ><small>{{ device.id }}</small>
            </td>
            <td data-label="所属用户">
              {{ device.username || device.userId }}
            </td>
            <td data-label="运行信息">
              {{ device.deviceOs || '—'
              }}<small
                >{{ device.connectorKind }} · {{ device.version || '—' }}</small
              >
            </td>
            <td data-label="连接状态">
              {{
                device.blockedAt
                  ? '已阻断'
                  : device.status === 'online'
                    ? '在线'
                    : '离线'
              }}<small>{{ device.blockedReason }}</small>
            </td>
            <td data-label="最近在线">
              {{
                device.lastSeenAt
                  ? new Date(device.lastSeenAt).toLocaleString()
                  : '—'
              }}
            </td>
            <td data-label="运维操作">
              <el-button
                v-if="
                  vm.auth.can('devices.connection.manage') &&
                  device.executorKind !== 'server-agent'
                "
                link
                :type="device.blockedAt ? 'primary' : 'danger'"
                :disabled="vm.mutation.busy.value"
                @click="vm.select(device)"
                >{{ device.blockedAt ? '恢复连接' : '阻断连接' }}</el-button
              ><small v-else-if="device.executorKind === 'server-agent'"
                >平台管理</small
              >
            </td>
          </tr>
          <tr
            v-if="
              !vm.resource.loading.value &&
              !vm.resource.error.value &&
              !vm.resource.data.value?.devices.length
            "
          >
            <td colspan="6" class="empty-cell">没有匹配的设备。</td>
          </tr>
        </tbody>
      </DataTable>
      <template #pagination>
        <ManagementPagination
          v-model:current-page="vm.page.value"
          v-model:page-size="vm.pageSize.value"
          :total="vm.resource.data.value?.total ?? 0"
          :page-sizes="[10, 20, 50]"
        />
      </template>
    </ManagementList>

    <el-dialog
      :model-value="Boolean(vm.selected.value)"
      :title="vm.selected.value?.blockedAt ? '恢复设备连接' : '阻断设备连接'"
      width="min(560px, 94vw)"
      @update:model-value="vm.selected.value = null"
      ><p>
        {{ vm.selected.value?.name }} ·
        {{ vm.selected.value?.username || vm.selected.value?.userId }}
      </p>
      <p>
        {{
          vm.selected.value?.blockedAt
            ? '恢复后，此设备可重新连接平台。'
            : '阻断会立即断开平台连接，并阻止自动重连；设备上的本地任务不会被终止。'
        }}
      </p>
      <label v-if="!vm.selected.value?.blockedAt"
        >阻断原因（可选）<el-input
          v-model="vm.reason.value"
          maxlength="500" /></label
      ><el-alert
        v-if="vm.mutation.error.value"
        :title="vm.mutation.error.value"
        type="error"
        :closable="false"
      /><template #footer
        ><el-button
          :disabled="vm.mutation.busy.value"
          @click="vm.selected.value = null"
          >取消</el-button
        ><el-button
          :type="vm.selected.value?.blockedAt ? 'primary' : 'danger'"
          :loading="vm.mutation.busy.value"
          @click="vm.operate"
          >确认</el-button
        ></template
      ></el-dialog
    >
  </section>
</template>
<style scoped>
small {
  display: block;
  color: var(--el-text-color-secondary);
}
td {
  overflow-wrap: anywhere;
}
</style>
