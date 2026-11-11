<script setup lang="ts">
import ManagementList from '@/components/management/ManagementList.vue'
import RowActions from '@/components/management/RowActions.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import FilterBar from '@/components/management/FilterBar.vue'
import DataTable from '@/components/management/DataTable.vue'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
import { useFiles } from '@/composables/files/use-files'
import {
  fileSize,
  previewKind,
  fileTypeLabel,
} from '@/utils/files/presentation'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import '@/assets/styles/file-management.css'
/** 文件库保留上传进度、版本、引用与回收站操作；下载前核对摘要。 */
const vm = useFiles()
</script>
<template>
  <section class="page paged-page management-page file-management-page">
    <PageHeader title="我的文件" />
    <ResourceStatus
      :loading="vm.resource.loading.value"
      :has-data="Boolean(vm.resource.data.value)"
      :error="vm.resource.error.value"
      @retry="vm.resource.reload"
    /><el-alert
      v-if="vm.mutation.error.value || vm.transfer.error.value"
      :title="vm.mutation.error.value || vm.transfer.error.value"
      type="error"
      :closable="false"
    />
    <FilterBar class="toolbar file-search-toolbar" @submit="vm.search">
      <el-input
        v-model="vm.query.value"
        placeholder="搜索文件名"
        aria-label="搜索文件名"
        clearable
      /><el-button @click="vm.toggleTrash">{{
        vm.filter.deleted ? '返回文件' : '回收站'
      }}</el-button
      ><el-button
        v-if="vm.auth.can('files.write')"
        type="primary"
        @click="vm.openUpload()"
        >上传文件</el-button
      >
    </FilterBar>
    <ManagementList :page="vm.filter.page" :page-size="vm.filter.pageSize">
      <DataTable mobile-cards label="数据列表">
        <thead>
          <tr>
            <th>文件名</th>
            <th>类型 / 大小</th>
            <th>版本 / 引用</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="item in vm.resource.data.value?.items ?? []"
            :key="item.id"
          >
            <td class="file-name-cell">
              <strong>{{ item.name }}</strong>
            </td>
            <td data-label="类型 / 大小">
              <span :title="item.mediaType">{{
                fileTypeLabel(item.mediaType)
              }}</span
              ><small>{{ fileSize(item.size) }}</small>
            </td>
            <td data-label="版本 / 引用">
              v{{ item.version }} · {{ item.references?.length ?? 0 }} 处引用
            </td>
            <td>
              <RowActions
                :busy="vm.mutation.busy.value || vm.transfer.busy.value"
              >
                <el-button
                  v-if="!item.deletedAt"
                  text
                  size="small"
                  :disabled="vm.transfer.busy.value"
                  @click="vm.download(item)"
                  >下载</el-button
                >
                <el-button
                  v-if="!item.deletedAt && previewKind(item.mediaType)"
                  text
                  size="small"
                  :disabled="vm.transfer.busy.value"
                  @click="vm.showPreview(item)"
                  >预览</el-button
                >
                <el-button link @click="vm.versionTarget.value = item"
                  >版本</el-button
                >
                <el-button
                  v-if="vm.auth.can('files.write') && !item.deletedAt"
                  link
                  @click="vm.openUpload(item)"
                  >上传新版</el-button
                >
                <el-button
                  v-if="!item.deletedAt && vm.auth.can('storage.manage')"
                  link
                  @click="vm.openMigration(item)"
                  >迁移存储</el-button
                >
                <template v-if="vm.auth.can('files.write')">
                  <el-button v-if="item.deletedAt" link @click="vm.trash(item)"
                    >恢复</el-button
                  >
                  <el-popconfirm
                    v-else
                    :title="'将“' + item.name + '”移到回收站？'"
                    confirm-button-text="移到回收站"
                    cancel-button-text="取消"
                    @confirm="vm.trash(item)"
                  >
                    <template #reference
                      ><el-button
                        link
                        type="danger"
                        :disabled="
                          vm.mutation.busy.value ||
                          Boolean(item.references?.length)
                        "
                        :title="
                          item.references?.length ? '文件仍被引用' : undefined
                        "
                        >移到回收站</el-button
                      ></template
                    >
                  </el-popconfirm></template
                >
              </RowActions>
            </td>
          </tr>
          <tr
            v-if="
              !vm.resource.loading.value &&
              !vm.resource.error.value &&
              !vm.resource.data.value?.items.length
            "
          >
            <td colspan="4" class="empty-cell">暂无文件。</td>
          </tr>
        </tbody>
      </DataTable>
      <template #pagination>
        <ManagementPagination
          v-model:current-page="vm.filter.page"
          v-model:page-size="vm.filter.pageSize"
          :total="vm.resource.data.value?.total ?? 0"
          :page-sizes="[10, 20, 50]"
        />
      </template>
    </ManagementList>

    <el-dialog
      v-model="vm.uploadOpen.value"
      :title="
        vm.previous.value ? '上传新版 · ' + vm.previous.value.name : '上传文件'
      "
      width="min(560px, 94vw)"
      :close-on-click-modal="false"
      @closed="vm.stop"
      ><p>
        中断后重新选择同一文件可继续上传。完成大小、类型和哈希校验后文件才会可用。
      </p>
      <input
        type="file"
        aria-label="选择上传文件"
        :disabled="vm.transfer.busy.value"
        @change="vm.choose"
      />
      <p v-if="vm.selected.value">
        {{ vm.selected.value.name }} · {{ fileSize(vm.selected.value.size) }}
      </p>
      <el-progress
        v-if="vm.transfer.busy.value || vm.progress.value"
        :percentage="vm.progress.value"
      /><el-alert
        v-if="vm.transfer.error.value"
        :title="vm.transfer.error.value"
        type="error"
        :closable="false"
      /><template #footer
        ><el-button v-if="vm.transfer.busy.value" @click="vm.stop"
          >暂停上传</el-button
        ><el-button v-else @click="vm.uploadOpen.value = false">取消</el-button
        ><el-button
          type="primary"
          :loading="vm.transfer.busy.value"
          :disabled="!vm.selected.value"
          @click="vm.upload"
          >开始上传</el-button
        ></template
      ></el-dialog
    >
    <el-dialog
      :model-value="Boolean(vm.versionTarget.value)"
      title="文件版本"
      width="min(760px, 94vw)"
      @update:model-value="vm.versionTarget.value = null"
      ><ResourceStatus
        :loading="vm.versions.loading.value"
        :error="vm.versions.error.value"
        @retry="vm.versions.reload"
      />
      <ul class="version-list">
        <li v-for="item in vm.versions.data.value?.items ?? []" :key="item.id">
          <div>
            <strong>{{ item.name }} · 版本 {{ item.version }}</strong
            ><small
              >{{ item.createdAt }} · {{ fileSize(item.size) }} ·
              {{ item.deletedAt ? '已回收' : '可用' }}</small
            >
          </div>
          <el-button
            :disabled="Boolean(item.deletedAt) || vm.transfer.busy.value"
            @click="vm.download(item)"
            >下载</el-button
          >
        </li>
      </ul></el-dialog
    >
    <el-dialog
      :model-value="Boolean(vm.preview.value)"
      :title="vm.preview.value?.name"
      width="min(1000px, 94vw)"
      @update:model-value="vm.closePreview"
      ><ResourceStatus
        :loading="vm.transfer.busy.value"
        :error="vm.transfer.error.value"
      /><template v-if="vm.previewUrl.value"
        ><img
          v-if="vm.previewType.value === 'image'"
          class="file-preview"
          :src="vm.previewUrl.value"
          :alt="vm.preview.value?.name"
        /><video
          v-else-if="vm.previewType.value === 'video'"
          class="file-preview"
          :src="vm.previewUrl.value"
          controls
        /><audio
          v-else-if="vm.previewType.value === 'audio'"
          :src="vm.previewUrl.value"
          controls
        />
        <pre v-else-if="vm.previewType.value === 'text'">{{
          vm.previewText.value
        }}</pre>
        <iframe
          v-else-if="vm.previewType.value === 'pdf'"
          class="pdf-preview"
          :src="vm.previewUrl.value"
          title="PDF 预览"
          sandbox="allow-same-origin"
        />
        <p
          v-if="
            vm.previewType.value === 'text' &&
            (vm.preview.value?.size ?? 0) > 1048576
          "
        >
          预览只展示前 1 MiB，请下载查看全文。
        </p></template
      ></el-dialog
    >
    <ManagementDialog
      :model-value="Boolean(vm.migrating.value)"
      title="迁移文件存储"
      :busy="vm.mutation.busy.value"
      :error="vm.mutation.error.value || vm.storage.error.value"
      @update:model-value="vm.migrating.value = null"
      @submit="vm.migrate"
      ><p>
        {{ vm.migrating.value?.name }} ·
        先复制并校验目标，失败时保留源文件。结果未知请在文件存储页查询迁移记录。
      </p>
      <el-select v-model="vm.targetStorage.value" placeholder="选择目标存储"
        ><el-option
          v-for="item in vm.storage.data.value?.connections ?? []"
          :key="item.id"
          :value="item.id"
          :label="item.name"
          :disabled="
            !item.enabled || item.id === vm.migrating.value?.storageId
          " /></el-select
    ></ManagementDialog>
  </section>
</template>
<style scoped>
small {
  display: block;
  color: var(--el-text-color-secondary);
}
.version-list {
  list-style: none;
  padding: 0;
}
.version-list li {
  display: flex;
  gap: 16px;
  align-items: center;
  justify-content: space-between;
  padding: 14px 0;
  border-bottom: 1px solid var(--el-border-color);
}
.file-preview {
  max-width: 100%;
  max-height: 65vh;
}
.pdf-preview {
  width: 100%;
  height: 70vh;
  border: 0;
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 65vh;
  overflow: auto;
}
</style>
