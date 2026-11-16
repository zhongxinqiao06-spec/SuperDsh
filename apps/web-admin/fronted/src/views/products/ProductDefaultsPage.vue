<script setup lang="ts">
import DataTable from '@/components/management/DataTable.vue'
import FilterBar from '@/components/management/FilterBar.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import { useProductDefaults } from '@/composables/products/use-product-defaults'
import type { Capability } from '@/types/models/models'
const labels: Record<Capability, string> = {
  chat: '对话',
  'image.generate': '图片生成',
  'vision.analyze': '视觉理解',
  'web.search': '联网搜索',
  'speech.transcribe': '语音转写',
  'speech.synthesize': '语音合成',
  'video.generate': '视频生成',
  embedding: '向量嵌入',
}
const vm = useProductDefaults()
</script>
<template>
  <section class="page management-page">
    <PageHeader title="默认模型" />
    <FilterBar @submit="vm.resource.reload"
      ><el-button native-type="submit" :loading="vm.resource.loading.value"
        >刷新</el-button
      ></FilterBar
    >
    <ResourceStatus
      :loading="vm.resource.loading.value"
      :error="vm.resource.error.value"
      :empty="!!vm.resource.data.value && !vm.rows.value.length"
      empty-title="尚无可选模型配置"
      empty-description="请平台管理员先配置并授权本产品可使用的模型。"
      @retry="vm.resource.reload"
    />
    <DataTable v-if="vm.rows.value.length" mobile-cards label="产品默认模型">
      <thead>
        <tr>
          <th>能力</th>
          <th>生效模型</th>
          <th>来源</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in vm.rows.value" :key="row.capability">
          <td>{{ labels[row.capability] ?? row.capability }}</td>
          <td data-label="生效模型">{{ row.effectiveLabel }}</td>
          <td data-label="来源">
            {{ row.overridden ? '本产品配置' : '平台默认' }}
          </td>
          <td data-label="操作">
            <el-button link @click="vm.edit(row.capability)"
              >选择模型</el-button
            >
          </td>
        </tr>
      </tbody>
    </DataTable>
    <ManagementDialog
      :model-value="!!vm.editing.value"
      title="选择默认模型"
      :busy="vm.mutation.busy.value"
      :error="vm.mutation.error.value"
      @submit="vm.save"
      @update:model-value="vm.editing.value = null"
    >
      <label class="field"
        >默认模型<el-select v-model="vm.selection.value" aria-label="选择模型"
          ><el-option label="跟随平台默认" value="" /><el-option
            v-for="c in vm.choices.value"
            :key="c.id"
            :value="c.id"
            :label="c.name + ' · ' + c.modelId" /></el-select
      ></label>
    </ManagementDialog>
  </section>
</template>
