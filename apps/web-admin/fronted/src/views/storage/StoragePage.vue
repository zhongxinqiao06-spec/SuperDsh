<script setup lang="ts">
import RowActions from '@/components/management/RowActions.vue'
import ManagementList from '@/components/management/ManagementList.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import DataTable from '@/components/management/DataTable.vue'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
import { computed } from 'vue'
import { useStorage } from '@/composables/storage/use-storage'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import ConnectionEditor from '@/views/storage/components/ConnectionEditor.vue'
import '@/assets/styles/file-management.css'
/** 存储运维只呈现连接、策略和元数据统计，不提供越权文件读取入口。 */
const vm = useStorage()
const rows = computed(() =>
  (vm.resource.data.value?.settings.connections ?? []).slice(
    (vm.page.value - 1) * vm.pageSize.value,
    vm.page.value * vm.pageSize.value,
  ),
)
</script>
<template>
  <section class="page paged-page management-page file-management-page">
    <PageHeader title="文件存储" />
    <div class="toolbar toolbar-panel">
      <el-button :disabled="!vm.resource.data.value" @click="vm.editPolicy"
        >策略与默认存储</el-button
      >
      <el-button type="primary" @click="vm.edit('new')">新增连接</el-button>
      <el-button @click="vm.resource.reload">刷新</el-button>
      <el-button
        :disabled="vm.mutation.busy.value"
        @click="vm.cleaning.value = true"
        >清理过期文件</el-button
      >
    </div>
    <ResourceStatus
      :loading="vm.resource.loading.value"
      :error="vm.resource.error.value"
      @retry="vm.resource.reload"
    /><el-alert
      v-if="vm.mutation.error.value"
      type="error"
      :title="vm.mutation.error.value"
      :closable="false"
    /><el-alert
      v-if="vm.notice.value"
      type="success"
      :title="vm.notice.value"
      :closable="false"
    />
    <ManagementList :page="vm.page.value" :page-size="vm.pageSize.value">
      <p class="file-storage-usage">
        已登记文件 {{ vm.resource.data.value?.usage.files ?? 0 }} 个 ·
        {{
          ((vm.resource.data.value?.usage.bytes ?? 0) / 1024 / 1024).toFixed(1)
        }}
        MiB（元数据统计，不含源备份或桶内其他对象）
      </p>
      <DataTable mobile-cards label="数据列表">
        <thead>
          <tr>
            <th>名称</th>
            <th>存储位置</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in rows" :key="item.id">
            <td>{{ item.name }}</td>
            <td data-label="存储位置">
              {{ item.backend }} ·
              {{ item.configuration.endpoint || '本地目录' }} /
              {{ item.configuration.bucket }}
            </td>
            <td data-label="状态">
              {{ item.enabled ? '启用' : '停用' }}
              <span
                v-if="
                  item.id ===
                  vm.resource.data.value?.settings.activeConnectionId
                "
              >
                · 新文件默认</span
              >
            </td>
            <td>
              <RowActions :busy="vm.mutation.busy.value">
                <el-button
                  v-if="item.backend !== 'local'"
                  link
                  @click="vm.edit(item)"
                  >编辑</el-button
                >
                <el-button
                  link
                  :disabled="vm.mutation.busy.value"
                  @click="vm.check(item)"
                  >检查连接</el-button
                >
              </RowActions>
            </td>
          </tr>
          <tr
            v-if="
              !vm.resource.loading.value &&
              !vm.resource.error.value &&
              !rows.length
            "
          >
            <td colspan="4" class="empty-cell">暂无存储连接。</td>
          </tr>
        </tbody>
      </DataTable>
      <section v-if="vm.resource.data.value?.migrations.cleanup?.length">
        <h2>待重试的对象清理</h2>
        <p>
          存储恢复后点击“清理过期文件”重试。文件迁移已完成的结果不受旧对象清理影响。
        </p>
        <ul>
          <li
            v-for="job in vm.resource.data.value.migrations.cleanup"
            :key="job.id"
          >
            {{ job.fileId }} · {{ job.storageId }} ·
            {{ job.error || '等待清理' }}
          </li>
        </ul>
      </section>
      <section v-if="vm.resource.data.value?.migrations.records.length">
        <h2>文件迁移记录</h2>
        <p
          v-for="state in vm.resource.data.value.migrations.items"
          :key="state.state"
        >
          {{ state.state }}：{{ state.total }}
        </p>
        <DataTable mobile-cards label="数据列表">
          <thead>
            <tr>
              <th>操作</th>
              <th>文件</th>
              <th>源 → 目标</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="item in vm.resource.data.value.migrations.records"
              :key="item.id"
            >
              <td>{{ item.id }}</td>
              <td data-label="文件">{{ item.fileId }}</td>
              <td data-label="源 → 目标">
                {{ item.sourceId }} → {{ item.targetId }}
              </td>
              <td data-label="状态">
                {{ item.state }}<small>{{ item.error }}</small>
              </td>
            </tr>
          </tbody>
        </DataTable>
      </section>
      <template #pagination>
        <ManagementPagination
          v-model:current-page="vm.page.value"
          v-model:page-size="vm.pageSize.value"
          :total="vm.resource.data.value?.settings.connections.length ?? 0"
          :page-sizes="[10, 20, 50]"
        />
      </template>
    </ManagementList>

    <ManagementDialog
      :model-value="Boolean(vm.editing.value)"
      title="存储连接"
      :busy="vm.mutation.busy.value"
      :error="vm.mutation.error.value"
      @update:model-value="vm.editing.value = null"
      @submit="vm.save"
      ><p class="muted">
        已有存储位置不可覆盖。迁移需复制、校验后显式切换；留空凭据保留原值。
      </p>
      <ConnectionEditor
        :draft="vm.draft"
        :existing="vm.editing.value !== 'new'"
        @update:draft="vm.updateDraft"
    /></ManagementDialog>
    <ManagementDialog
      :model-value="Boolean(vm.policy.value)"
      title="文件策略"
      submit-text="检查并保存"
      :busy="vm.mutation.busy.value"
      :error="vm.mutation.error.value"
      @update:model-value="vm.policy.value = null"
      @submit="vm.savePolicy"
      ><template v-if="vm.policy.value"
        ><label
          >新文件默认存储<el-select v-model="vm.policy.value.activeConnectionId"
            ><el-option
              v-for="item in vm.policy.value.connections"
              :key="item.id"
              :label="item.name"
              :value="item.id"
              :disabled="!item.enabled" /></el-select></label
        ><label
          >上传上限（字节）<el-input-number
            v-model="vm.policy.value.policy.maxFileBytes"
            :min="1"
            :max="1073741824"
            :step="1048576" /></label
        ><label
          >暂存保留（小时）<el-input-number
            v-model="vm.policy.value.policy.temporaryHours"
            :min="1"
            :max="720" /></label
        ><label
          >回收站保留（天）<el-input-number
            v-model="vm.policy.value.policy.recycleDays"
            :min="1"
            :max="3650"
        /></label>
        <p>切换默认连接只影响新上传，已有文件保留原存储位置。</p></template
      ></ManagementDialog
    >
    <el-dialog
      :model-value="vm.cleaning.value"
      title="清理过期文件"
      width="min(480px, 94vw)"
      @update:model-value="vm.cleaning.value = false"
      ><p>
        按保留策略删除已过期且无资源引用的回收站文件及上传分片。此操作不可恢复。
      </p>
      <el-alert
        v-if="vm.mutation.error.value"
        :title="vm.mutation.error.value"
        type="error"
        :closable="false"
      /><template #footer
        ><el-button
          :disabled="vm.mutation.busy.value"
          @click="vm.cleaning.value = false"
          >取消</el-button
        ><el-button
          type="danger"
          :loading="vm.mutation.busy.value"
          @click="vm.cleanup"
          >确认清理</el-button
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
