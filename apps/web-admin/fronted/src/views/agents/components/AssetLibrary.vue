<script setup lang="ts">
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import RowActions from '@/components/management/RowActions.vue'
import DataTable from '@/components/management/DataTable.vue'
import { computed, ref, watch } from 'vue'
import type { AgentAsset, AssetKind } from '@/types/agents/agents'
import { dateTimeLabel } from '@/utils/date-time'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
/** 资料列表为受控组件，所有上传、下载和预览交给页面用例。 */
const props = defineProps<{
  assets: AgentAsset[]
  busy: boolean
  error: string
  uploading: boolean
  kind: AssetKind
  filename: string
  name: string
  removable?: boolean
  preview: AgentAsset | null
  previewUrl: string
}>()
defineEmits<{
  upload: []
  choose: [event: Event]
  'update:uploading': [value: boolean]
  'update:kind': [value: AssetKind]
  'update:name': [value: string]
  preview: [asset: AgentAsset]
  download: [asset: AgentAsset]
  closePreview: []
  remove: [asset: AgentAsset]
}>()
const query = ref(''),
  page = ref(1),
  pageSize = ref(10)
const filtered = computed(() =>
  props.assets.filter((asset) =>
    asset.name
      .toLocaleLowerCase()
      .includes(query.value.trim().toLocaleLowerCase()),
  ),
)
const rows = computed(() =>
  filtered.value.slice(
    (page.value - 1) * pageSize.value,
    page.value * pageSize.value,
  ),
)
const accept = computed(() =>
  props.kind === 'knowledge'
    ? '.txt,.md,.csv,.xlsx,.docx,.pdf'
    : props.kind === 'spreadsheet-template'
      ? '.xlsx'
      : props.kind === 'document-template'
        ? '.docx'
        : '.pptx',
)
watch([query, pageSize], () => {
  page.value = 1
})
watch(
  () => filtered.value.length,
  (count) => {
    page.value = Math.min(
      page.value,
      Math.max(1, Math.ceil(count / pageSize.value)),
    )
  },
)
</script>

<template>
  <div class="toolbar">
    <el-input
      v-model="query"
      placeholder="搜索资料和模板"
      aria-label="搜索资料和模板"
    />
    <span class="toolbar-spacer" />
    <el-button :disabled="busy" @click="$emit('update:uploading', true)"
      >上传资料或模板</el-button
    >
  </div>
  <el-alert v-if="error" type="error" :title="error" :closable="false" />
  <DataTable label="数据列表">
    <thead>
      <tr>
        <th>名称</th>
        <th>类型</th>
        <th>大小</th>
        <th>上传时间</th>
        <th>操作</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="asset in rows" :key="asset.id">
        <td>{{ asset.name }}</td>
        <td>
          {{
            {
              knowledge: '知识资料',
              'spreadsheet-template': '表格模板',
              'document-template': '文档模板',
              'presentation-template': '演示模板',
            }[asset.kind]
          }}
        </td>
        <td>{{ Math.max(1, Math.ceil(asset.size / 1024)) }} KB</td>
        <td>{{ dateTimeLabel(asset.createdAt) }}</td>
        <td>
          <RowActions :busy="busy">
            <el-button link :disabled="busy" @click="$emit('preview', asset)"
              >查看</el-button
            >
            <el-button link :disabled="busy" @click="$emit('download', asset)"
              >下载</el-button
            >
            <el-button
              v-if="removable"
              link
              :disabled="busy"
              @click="$emit('remove', asset)"
              >移出知识库</el-button
            >
          </RowActions>
        </td>
      </tr>
      <tr v-if="!rows.length">
        <td colspan="5" class="empty-cell">
          暂无资料，可上传文件或调整搜索条件。
        </td>
      </tr>
    </tbody>
  </DataTable>
  <ManagementPagination
    v-model:current-page="page"
    v-model:page-size="pageSize"
    :total="filtered.length"
    :page-sizes="[10, 20, 50]"
  />
  <ManagementDialog
    :model-value="uploading"
    title="上传资料或模板"
    width="min(520px, 94vw)"
    :busy="busy"
    :error="error"
    submit-text="上传并解析"
    @update:model-value="$emit('update:uploading', $event)"
    @submit="$emit('upload')"
  >
    <label
      >名称<el-input
        :disabled="busy"
        :model-value="name"
        maxlength="200"
        @update:model-value="$emit('update:name', $event)"
    /></label>
    <label
      >文件用途<el-select
        :disabled="busy"
        :model-value="kind"
        @update:model-value="$emit('update:kind', $event)"
        ><el-option value="knowledge" label="知识资料" /><el-option
          value="spreadsheet-template"
          label="表格模板（XLSX）" /><el-option
          value="document-template"
          label="文档模板（DOCX）" /><el-option
          value="presentation-template"
          label="演示模板（PPTX）" /></el-select></label
    ><label
      >文件（最多 4 MiB）<input
        type="file"
        :accept="accept"
        :disabled="busy"
        @change="$emit('choose', $event)"
    /></label>
    <p>{{ filename }}</p>
  </ManagementDialog>
  <el-dialog
    :model-value="Boolean(preview)"
    :title="preview?.name ?? '资料预览'"
    width="min(960px, 95vw)"
    @update:model-value="$emit('closePreview')"
    ><iframe
      v-if="previewUrl"
      :src="previewUrl"
      title="资料 PDF 预览"
      class="preview-frame" />
    <pre v-else class="preview-text">{{ preview?.preview }}</pre>
    <p v-if="busy">正在准备预览…</p>
    <el-alert v-if="error" type="error" :title="error" :closable="false"
  /></el-dialog>
</template>

<style scoped>
.preview-frame {
  width: 100%;
  height: 65vh;
  border: 0;
}
.preview-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 60vh;
  overflow: auto;
}
</style>
