<script setup lang="ts">
import { computed, ref } from 'vue'
import { studioApi } from '@/api/studio/studio-api'
import { useStudioDirectory } from '@/composables/studio/use-studio-directory'
import { useMutation } from '@/composables/use-mutation'
import type { StudioAsset, StudioProject } from '@/types/studio/studio'
import { currentProjectAssets } from '@/utils/studio/library'
import ManagementDialog from '@/components/overlay/ManagementDialog.vue'
import ManagementPagination from '@/components/management/ManagementPagination.vue'
import ResourceStatus from '@/components/feedback/ResourceStatus.vue'
import StudioAssetCard from './StudioAssetCard.vue'
import StudioAssetDetail from './StudioAssetDetail.vue'

/** 挑选只改变预览；明确确认后才由宿主导入版本，目标作品与镜头始终由宿主提供。 */
const props = defineProps<{
  project?: StudioProject
  title: string
  kinds: StudioAsset['kind'][]
  resolve: (asset: StudioAsset) => Promise<StudioAsset>
  selectedId?: string | null
  personalFirst?: boolean
  excludeIds?: string[]
}>()
const emit = defineEmits<{ close: []; selected: [asset: StudioAsset] }>()
const scope = ref(
  props.personalFirst || !props.project ? 'personal' : 'project',
)
const selected = ref<StudioAsset>()
const inspecting = ref<StudioAsset>()
const mutation = useMutation()
const { data, loading, error, reload, query, filter, search, page, pageSize } =
  useStudioDirectory((params, signal) =>
    studioApi.libraryPage(
      { ...params, scope: 'personal', kind: '', kinds: props.kinds.join(',') },
      signal,
    ),
  )
const projectAssets = computed(() =>
  props.project
    ? currentProjectAssets(
        props.project.assets,
        props.project.document.assets,
        props.kinds,
      ).filter(
        (asset) =>
          !search.value ||
          (asset.name + asset.description)
            .toLowerCase()
            .includes(search.value.toLowerCase()),
      )
    : [],
)
const items = computed(() =>
  (scope.value === 'project'
    ? projectAssets.value
    : (data.value?.items ?? []).filter((asset) =>
        props.kinds.includes(asset.kind),
      )
  ).filter((asset) => !props.excludeIds?.includes(asset.id)),
)
async function confirm() {
  if (!selected.value) return
  let result: StudioAsset | undefined
  if (
    (await mutation.run(async () => {
      result = await props.resolve(selected.value!)
    })) &&
    result
  )
    emit('selected', result)
}
function choose(asset: StudioAsset) {
  if (!mutation.busy.value) selected.value = asset
}
</script>
<template>
  <ManagementDialog
    :model-value="true"
    :title="title"
    :busy="mutation.busy.value"
    :error="mutation.error.value"
    :submit-disabled="!selected"
    submit-text="使用所选素材"
    width="min(1000px, calc(100vw - 32px))"
    @submit="confirm"
    @update:model-value="emit('close')"
  >
    <template #toolbar>
      <el-tabs v-model="scope" class="library-tabs" aria-label="素材来源"
        ><el-tab-pane
          v-if="project"
          label="本片素材"
          name="project" /><el-tab-pane label="我的素材库" name="personal"
      /></el-tabs>
      <div class="toolbar">
        <el-input
          v-model="query"
          placeholder="搜索名称或设定"
          aria-label="搜索可选素材"
          @keydown.enter.prevent="filter"
        /><el-button @click="filter">搜索</el-button>
      </div>
    </template>
    <ResourceStatus
      v-if="scope === 'personal'"
      :loading="loading"
      :error="error"
      :has-data="!!data?.items.length"
      @retry="reload"
    />
    <p
      v-if="!items.length && (scope === 'project' || (!loading && !error))"
      class="studio-meta"
    >
      {{
        scope === 'project'
          ? '本片尚无符合条件的素材，可以切换到我的素材库选用。'
          : '没有符合条件的素材，可先在素材中心创建或从其他作品收藏。'
      }}
    </p>
    <div
      class="library-grid library-picker-grid"
      role="group"
      aria-label="可选素材"
    >
      <StudioAssetCard
        v-for="asset in items"
        :key="asset.id"
        :asset="asset"
        selectable
        :selected="selected?.id === asset.id"
        @select="choose(asset)"
        ><template #actions
          ><el-button
            link
            :disabled="mutation.busy.value"
            @click="choose(asset)"
            >{{ selected?.id === asset.id ? '已选择' : '选择' }}</el-button
          ><el-button
            link
            :disabled="mutation.busy.value"
            @click="inspecting = asset"
            >预览与版本</el-button
          ><el-tag v-if="selectedId === asset.id" size="small"
            >当前使用</el-tag
          ></template
        ></StudioAssetCard
      >
    </div>
    <ManagementPagination
      v-if="scope === 'personal'"
      v-model:current-page="page"
      v-model:page-size="pageSize"
      :total="data?.total ?? 0"
      :loading="loading"
    />
    <template #footer-leading
      ><span v-if="selected" class="library-selection-summary" role="status"
        >已选：{{ selected.name }} · 版本 {{ selected.version }}</span
      ></template
    >
    <StudioAssetDetail
      v-if="inspecting"
      :asset="inspecting"
      selectable
      @close="inspecting = undefined"
      @choose="
        (asset) => {
          selected = asset
          inspecting = undefined
        }
      "
    />
  </ManagementDialog>
</template>
<style scoped src="../../../../assets/styles/studio-library.css"></style>
