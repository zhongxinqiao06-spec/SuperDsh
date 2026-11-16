<script setup lang="ts">
import { ref } from 'vue'
import { studioApi } from '@/api/studio/studio-api'
import { useMutation } from '@/composables/use-mutation'
import { useStudioDirectory } from '@/composables/studio/use-studio-directory'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import type { StudioAsset } from '@/types/studio/studio'
const props = defineProps<{ asset: StudioAsset }>()
const emit = defineEmits<{ close: []; linked: [title: string] }>()
const { data, query, filter, page, pageSize, loading, error, reload } =
  useStudioDirectory(studioApi.projectPage)
const mutation = useMutation()
const selected = ref<{ id: string; title: string }>()
async function link() {
  const project = selected.value
  if (!project) return
  if (await mutation.run(() => studioApi.linkAsset(project.id, props.asset.id)))
    emit('linked', project.title)
}
</script>
<template>
  <ManagementDialog
    :model-value="true"
    title="引用到作品"
    submit-text="引用此版本"
    :busy="mutation.busy.value"
    :error="mutation.error.value"
    :submit-disabled="!selected"
    @submit="link"
    @update:model-value="emit('close')"
  >
    <strong>{{ asset.name }}</strong>
    <div class="toolbar">
      <el-input
        v-model="query"
        maxlength="120"
        placeholder="搜索作品名称"
        aria-label="搜索可引用作品"
        @keydown.enter.prevent="filter"
      /><el-button @click="filter">搜索</el-button>
    </div>
    <ResourceStatus
      :loading="loading"
      :error="error"
      :empty="!data?.total"
      empty-title="没有可选作品"
      empty-description="请先在作品项目中创建作品，或调整搜索条件。"
      @retry="reload"
    />
    <div
      v-if="data?.total"
      role="radiogroup"
      aria-label="选择作品"
      class="stack"
    >
      <label v-for="project in data.items" :key="project.id"
        ><input
          type="radio"
          name="target-project"
          :checked="selected?.id === project.id"
          @change="selected = project"
        />
        {{ project.title }}</label
      >
    </div>
    <ManagementPagination
      v-model:current-page="page"
      v-model:page-size="pageSize"
      :total="data?.total ?? 0"
      :loading="loading"
    />
  </ManagementDialog>
</template>
