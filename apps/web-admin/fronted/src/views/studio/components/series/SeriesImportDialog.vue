<script setup lang="ts">
import { ref } from 'vue'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import { useStudioDirectory } from '@/composables/studio/use-studio-directory'
import { useMutation } from '@/composables/use-mutation'
import { worksApi } from '@/api/studio/works-api'
import type { WorkSummary } from '@/types/studio/works'

/** 仅列出未加入整剧的本人分镜作品；加入保留原工程身份与历史。 */
const props = defineProps<{ submit: (work: WorkSummary) => Promise<void> }>()
const emit = defineEmits<{ close: [] }>()
const selected = ref<WorkSummary>(),
  mutation = useMutation()
const { data, loading, error, reload, query, filter, page, pageSize } =
  useStudioDirectory((params, signal) =>
    worksApi.page(
      { ...params, mode: 'storyboard', lifecycle: 'active' },
      signal,
    ),
  )
async function handleSubmit() {
  if (
    selected.value &&
    (await mutation.run(() => props.submit(selected.value!)))
  )
    emit('close')
}
</script>
<template>
  <ManagementDialog
    :model-value="true"
    title="从已有作品加入一集"
    :busy="mutation.busy.value"
    :error="mutation.error.value"
    :submit-disabled="!selected"
    submit-text="加入本剧"
    @submit="handleSubmit"
    @update:model-value="emit('close')"
  >
    <template #toolbar
      ><div class="toolbar">
        <el-input
          v-model="query"
          aria-label="搜索可加入的作品"
          placeholder="搜索分镜作品"
          @keydown.enter.prevent="filter"
        /><el-button @click="filter">搜索</el-button>
      </div></template
    >
    <div class="form-stack">
      <p class="studio-meta">
        原镜头、素材、配音、剪辑和成片都保留。加入后该作品在本剧内管理，不重复出现在顶层作品目录。
      </p>
      <ResourceStatus
        :loading="loading"
        :error="error"
        :has-data="!!data?.total"
        @retry="reload"
      /><el-radio-group
        :model-value="selected?.id"
        class="form-stack"
        aria-label="选择已有作品"
        @update:model-value="
          selected = data?.items.find((work) => work.id === $event)
        "
        ><el-radio v-for="work in data?.items" :key="work.id" :value="work.id"
          >{{ work.title }} · {{ work.shots }}个镜头 · 工程修订{{
            work.revision
          }}</el-radio
        ></el-radio-group
      >
      <p v-if="!loading && !error && !data?.total" class="empty-cell">
        暂无可加入的分镜作品。快速视频需要先进入分镜创作。
      </p>
      <ManagementPagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="data?.total ?? 0"
        :loading="loading"
      />
    </div>
  </ManagementDialog>
</template>
