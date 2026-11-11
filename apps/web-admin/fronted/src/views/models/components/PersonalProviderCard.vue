<script setup lang="ts">
import RowActions from '@/components/management/RowActions.vue'
import DataTable from '@/components/management/DataTable.vue'
import { computed, ref, watch } from 'vue'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
import type { ModelProvider } from '@/types/models/models'

/** 个人供应商的只读卡片与模型分页；写入操作由页面用例负责授权和状态回收。 */
const props = defineProps<{
  provider: ModelProvider
  selectedModelId: string | null
  busy: boolean
}>()
const emit = defineEmits<{
  edit: []
  verify: []
  remove: []
  select: [modelId: string]
}>()
const page = ref(1),
  pageSize = ref(10)
const models = computed(() =>
  props.provider.models.slice(
    (page.value - 1) * pageSize.value,
    page.value * pageSize.value,
  ),
)
watch([() => props.provider.providerId, pageSize], () => {
  page.value = 1
})
watch(
  () => props.provider.models.length,
  (count) => {
    page.value = Math.min(
      page.value,
      Math.max(1, Math.ceil(count / pageSize.value)),
    )
  },
)
</script>

<template>
  <article class="personal-provider-card">
    <header class="personal-provider-heading">
      <div>
        <h3>
          {{ provider.name }}
          <small>{{ provider.enabled ? '已启用' : '已停用' }}</small>
        </h3>
        <p>{{ provider.protocol }} · {{ provider.baseUrl }}</p>
        <p>{{ provider.apiKeyConfigured ? '密钥已配置' : '未配置密钥' }}</p>
      </div>
      <RowActions :busy="busy">
        <el-button :disabled="busy || !provider.enabled" @click="emit('verify')"
          >验证连接</el-button
        >
        <el-button link :disabled="busy" @click="emit('edit')">编辑</el-button>
        <el-button
          link
          :disabled="busy"
          class="danger-action"
          @click="emit('remove')"
          >删除</el-button
        >
      </RowActions>
    </header>
    <DataTable label="数据列表">
      <thead>
        <tr>
          <th>模型</th>
          <th>上下文 / 输出</th>
          <th>输入</th>
          <th>默认设置</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="model in models" :key="model.modelId">
          <td>
            {{ model.name }}<small>{{ model.modelId }}</small>
          </td>
          <td>
            {{ model.contextWindow ?? '—' }} / {{ model.maxTokens ?? '—' }}
          </td>
          <td>{{ model.inputTypes.join(', ') }}</td>
          <td>
            <span v-if="selectedModelId === model.modelId">当前默认</span
            ><el-button
              v-else
              :disabled="busy || !provider.enabled"
              @click="emit('select', model.modelId)"
              >设为默认</el-button
            >
          </td>
        </tr>
      </tbody>
    </DataTable>
    <ManagementPagination
      v-if="provider.models.length > 10"
      v-model:current-page="page"
      v-model:page-size="pageSize"
      :total="provider.models.length"
      :page-sizes="[10, 20, 50]"
      :loading="busy"
    />
  </article>
</template>

<style scoped>
.personal-provider-card {
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 14px;
}
.personal-provider-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px;
}
.personal-provider-heading h3 {
  margin: 0;
  font-size: 16px;
}
.personal-provider-heading h3 small {
  display: inline;
  font-weight: 400;
}
.personal-provider-heading p {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--muted-foreground);
  overflow-wrap: anywhere;
}
small {
  display: block;
  font-size: 12px;
  color: var(--muted-foreground);
}
.personal-provider-card .table-wrap {
  border: 0;
  border-radius: 0;
}
.personal-provider-card :deep(.management-pagination) {
  border: 0;
  border-top: 1px solid var(--border);
  border-radius: 0;
}
</style>
